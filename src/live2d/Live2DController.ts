import * as PIXI from "pixi.js";
import { invoke } from "@tauri-apps/api/core";
// 先求值占位，再加载 cubism4 入口（否则模块顶层检查会抛错）
import "./l2d-stub";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import type { PetDriver, PetView } from "./PetDriver";
import { getActivityFactor } from "../utils/settings";

/**
 * Live2D 模型控制器。
 * 模型约定放在 `public/models/<name>/`（含 model3.json）。
 * 前端通过 `/models/manifest.json` 声明使用哪个模型：
 *   { "active": "my-char", "scale": 2.0 }
 */
const l2dLog = (m: string) => { void invoke("debug_mark", { msg: m }).catch(() => {}); };

export class Live2DController implements PetView {
  container!: PIXI.Container;

  private model: Live2DModel | null = null;
  private baseScale = 1;
  private displayW = 300;
  private modelOffsetX = 0;
  private modelOffsetY = 0;
  private swayEnabled = true;
  private gobble = 0;
  private click = 0;
  private t = 0;
  private mirror = 1;
  private lastVx = 0;
  private rotSmooth = 0; // 待机倒挂旋转插值
  private exprT = 0;
  private exprDur = 1.8;
  private exprNext = 0;
  private exprKind = 0; // 0 无 1 微笑 2 惊讶 3 眯眼 4 委屈 5 winkL 6 winkR
  private exprW = 0;
  private lastDriver: PetDriver | null = null;
  private idleKind = 0;
  private idleP = 0;
  private idleDur = 2;
  private idleNext = 18;
  private idleClock = 0;

  static async create(): Promise<Live2DController | null> {
    try {
      Live2DModel.registerTicker(PIXI.Ticker);
    } catch (e) {
      l2dLog("l2d registerTicker fail: " + String(e));
      return null;
    }

    let active = "model";
    let desiredScale = 1;
    try {
      const res = await fetch("/models/manifest.json", { cache: "no-store" });
      l2dLog("l2d manifest status " + res.status);
      if (res.ok) {
        const manifest = await res.json();
        if (manifest.active) active = manifest.active;
        if (typeof manifest.scale === "number") desiredScale = manifest.scale;
      }
    } catch (e) {
      l2dLog("l2d manifest fetch fail: " + String(e));
    }

    const urls = [
      `/models/${active}/model3.json`,
      `/models/${active}/model.json`, // Cubism2 兜底
    ];

    let model: Live2DModel | null = null;
    for (const url of urls) {
      try {
        model = await Live2DModel.from(url, {
          autoInteract: false,
        });
        l2dLog("l2d loaded " + url);
        break;
      } catch (e) {
        l2dLog("l2d load fail " + url + " :: " + String(e));
        model = null;
      }
    }
    if (!model) { l2dLog("l2d no model, active=" + active); return null; }

    const ctrl = new Live2DController();
    ctrl.model = model;
    // 参数必须在 coreModel.update() 之前写入，否则会被模型自身重置
    try {
      const core = (model.internalModel as unknown as { coreModel: { update: () => void } }).coreModel;
      if (core && typeof core.update === "function") {
        const orig = core.update.bind(core);
        core.update = () => {
          ctrl.applyParams();
          orig();
        };
      }
    } catch (e) {
      l2dLog("wrap coreModel.update failed: " + String(e));
    }
    ctrl.baseScale = desiredScale;
    // displayW 是「模型目标显示边长」：默认铺满窗口（700），
    // 「模型大小」滑条在这个基准上按比例缩放
    ctrl.displayW = 700;
    ctrl.fit();
    // 首帧前强制模型完整更新一次：Cubism 的裁剪遮罩（clipping）与顶点都要等
    // internalModel.update() 之后才就绪，否则大模型会先露出身体、头部部件
    // 过一阵才出现（"初次启动头消失一段时间"的根因）。
    try {
      (model as unknown as { update?: (dt: number) => void }).update?.(0);
    } catch (e) {
      l2dLog("l2d warmup update fail: " + String(e));
    }
    // 纹理上传 + 首帧更新完成前先隐藏，避免中间态闪烁；双 rAF + 超时兜底
    ctrl.container.visible = false;
    const reveal = () => { if (ctrl.container) ctrl.container.visible = true; };
    requestAnimationFrame(() => requestAnimationFrame(reveal));
    window.setTimeout(reveal, 300);
    return ctrl;
  }

  private fit() {
    const m = this.model!;
    // 先把 scale 归位，才能从 m.width/height 读到原始画布尺寸
    m.scale.set(1, 1);
    const cw = (m as unknown as { width?: number }).width || 300;
    const ch = (m as unknown as { height?: number }).height || 300;
    // 窗口/画布边长 = displayW（main 会同步 resize），模型显示 90%，留 5% 边距
    const W = Math.max(120, this.displayW);
    const H = W;
    const target = Math.max(50, this.displayW);
    const s = Math.min((target * 0.9) / cw, (target * 0.9) / ch) * this.baseScale;
    m.scale.set(s, s);
    m.anchor.set(0.5, 0.5);
    m.position.set(W / 2, H / 2);
    this.container = m;
    const cvs = document.querySelector("canvas") as HTMLCanvasElement | null;
    const stageEl = document.getElementById("stage");
    l2dLog(
      "fit2: model=" + cw + "x" + ch + " win=" + W + "x" + H + " s=" + s.toFixed(5) +
      " pos=" + (W / 2) + "," + (H / 2) +
      " canvas=" + (cvs ? cvs.width + "x" + cvs.height : "none") +
      " stage=" + (stageEl ? stageEl.clientWidth + "x" + stageEl.clientHeight : "none"),
    );
  }

  update(d: PetDriver, dt: number) {
    const m = this.model;
    if (!m) return;
    this.lastDriver = d;
    this.t += dt;
    this.gobble = Math.max(0, this.gobble - dt * 3.2);
    this.click = Math.max(0, this.click - dt * 6);
    this.modelOffsetX = d.modelOffsetX || 0;
    this.modelOffsetY = d.modelOffsetY || 0;
    const W = Math.max(120, this.displayW);
    // 窗口边长 = displayW，模型以窗口中心定位
    m.position.set(W / 2 + this.modelOffsetX, W / 2 + this.modelOffsetY);
    if (Math.abs(d.vx) > 0.02) this.lastVx = d.vx;
    const wantMirror = this.lastVx < 0 ? -1 : 1;
    if (wantMirror !== this.mirror) {
      this.mirror = wantMirror;
      m.scale.x *= -1;
    }
    this.rotSmooth += ((d.idleTop ? Math.PI : 0) - this.rotSmooth) * Math.min(1, dt * 5);
    m.rotation = this.rotSmooth;

    // 待机小动作：每 20~45 秒随机触发一次，包络 0→1→0
    this.idleClock += dt;
    if (this.idleClock >= this.idleNext) {
      this.idleKind = 1 + Math.floor(Math.random() * 5);
      this.idleClock = 0;
      this.idleDur = 1.6 + Math.random() * 0.8;
      this.idleNext = 8 + Math.random() * 7;
    }
    this.idleP = this.idleClock < this.idleDur ? this.idleClock / this.idleDur : 0;

    this.applyParams(dt);
  }

  /** 每帧在 coreModel.update() 前写入所有 Cubism 参数（视线/呼吸/表情等）。 */
  private applyParams(dt: number = 0) {
    const m = this.model;
    const d = this.lastDriver;
    if (!m || !d) return;
    const core = (m.internalModel as unknown as {
      coreModel?: {
        parameters?: { setValueById: (id: string, v: number, w?: number) => void };
        setParameterValueById?: (id: string, v: number, w?: number) => void;
      };
    })?.coreModel;
    if (!core) return;
    const set = (param: string, v: number) => {
      try {
        core.setParameterValueById?.(param, v, 1);
      } catch {
        try {
          core.parameters?.setValueById(param, v, 1);
        } catch {
          /* ignore */
        }
      }
    };
    const sway = this.swayEnabled ? 1 : 0;
    const breathePhase = Math.sin(d.breathing);
    const musicX = Math.sin(this.t * 2.1) * d.bass * 16 * sway + d.vx * 10;
    const musicY = d.bass * 6 * sway + d.bob * 6;
    set("ParamBodyAngleX", musicX);
    set("ParamBodyAngleY", musicY);
    set("ParamBodyAngleZ", d.treble * 4 * sway * Math.sin(this.t * 3.3));

    // 随机表情：间隔随活动因子拉长，正弦包络淡入淡出；待机时安静
    this.exprT += dt;
    if (d.idle) {
      this.exprKind = 0;
      this.exprT = 0;
      this.exprNext = this.t + 60000;
    } else if (this.t > this.exprNext) {
      this.exprKind = 1 + Math.floor(Math.random() * 6);
      this.exprT = 0;
      this.exprDur = 1.6 + Math.random() * 0.9;
      this.exprNext = this.t + (8 + Math.random() * 8) * getActivityFactor();
    }
    this.exprW = this.exprT > this.exprDur ? 0 : Math.sin(Math.PI * Math.min(1, this.exprT / this.exprDur));
    const k = this.exprKind;
    const ew = this.exprW;
    const eBrow = k === 1 ? 0.35 * ew : k === 2 ? 0.8 * ew : k === 4 ? -0.4 * ew : 0;
    const eMouth = k === 2 ? 0.5 * ew : k === 1 ? 0.2 * ew : 0;
    const eEyeL = k === 5 || k === 3 ? (1 - 0.85 * ew) : 1;
    const eEyeR = k === 6 || k === 3 ? (1 - 0.85 * ew) : 1;
    const eForm = k === 1 ? 0.8 * ew : k === 3 ? 0.4 * ew : k === 4 ? -0.4 * ew : 0;

    // 顶部待机倒挂（旋转 180°）→ 视线横纵都镜像
    const flip = d.idleTop ? -1 : 1;
    set("ParamAngleX", Math.max(-25, Math.min(25, d.cursorDx * flip * 22)));
    set("ParamAngleY", Math.max(-15, Math.min(15, -d.cursorDy * flip * 12)));
    set("ParamAngleZ", Math.max(-10, Math.min(10, d.vx * 6)));
    // 眼球跟随（标准 Cubism 参数，范围 ±30；兴奋时更跟手）
    const exc = d.excited ?? 0;
    set("ParamEyeBallX", Math.max(-1, Math.min(1, d.cursorDx * flip * (0.6 + exc * 0.25))));
    set("ParamEyeBallY", Math.max(-1, Math.min(1, d.cursorDy * flip * (0.5 + exc * 0.2))));

    set("ParamBreath", 0.5 + breathePhase * 0.5);
    // 常驻头发飘动（没有物理也能一直有细微摆动）
    const hairPhase = this.t * 1.1;
    set("ParamHairFront", Math.sin(hairPhase) * 0.12 + (d.vx || 0) * 0.3);
    set("ParamHairSide", Math.sin(hairPhase + 1.2) * 0.10 + (d.vx || 0) * 0.2);
    set("ParamHairBack", Math.sin(hairPhase + 2.4) * 0.08);
    // 眼睛：中频能量 + 表情（眯眼/眨眼收敛）+ 兴奋睁大
    const baseEye = 1 - d.mid * 0.06 * sway;
    set("ParamEyeLOpen", Math.max(0, Math.min(1.1, baseEye * eEyeL + exc * 0.06)));
    set("ParamEyeROpen", Math.max(0, Math.min(1.1, baseEye * eEyeR + exc * 0.06)));
    set("ParamCheek", Math.max(0, d.bass * 0.7 * sway + (k === 1 ? 0.5 * ew : 0)));
    set("ParamBrowL", Math.max(-1, Math.min(1, d.treble * 0.4 * sway + eBrow)));
    set("ParamBrowR", Math.max(-1, Math.min(1, d.treble * 0.4 * sway + eBrow)));

    // 嘴：中频 + 节拍 + 吞咽/点击 + 表情 + 兴奋微张嘴
    const mouth = Math.min(
      1.5,
      d.mid * 1.2 * sway + d.beat * 0.6 * sway + this.gobble + this.click * 0.8 + eMouth + exc * 0.18,
    );
    set("ParamMouthOpenY", mouth);
    set("ParamMouthForm", Math.max(-1, Math.min(1, 0.5 + d.mid * 0.3 + eForm)));

    // 待机动作叠加
    const iw = this.idleP > 0 ? Math.sin(Math.PI * this.idleP) : 0;
    if (iw > 0.001) {
      const add = (param: string, v: number) => {
        try {
          const cur = (core as unknown as { getParameterValueById?: (id: string) => number }).getParameterValueById?.(param);
          if (typeof cur === "number") core.setParameterValueById?.(param, cur + v, 1);
        } catch {
          /* ignore */
        }
      };
      const k = this.idleKind;
      if (k === 1) {
        // 歪头
        add("ParamAngleZ", 22 * iw);
        add("ParamAngleX", 8 * iw);
        add("ParamEyeLOpen", -0.25 * iw);
        add("ParamEyeROpen", -0.25 * iw);
      } else if (k === 2) {
        // 先看左，再看右
        const first = this.idleP < 0.5;
        const local = first ? this.idleP * 2 : (this.idleP - 0.5) * 2;
        const w2 = Math.sin(Math.PI * local);
        const dir = first ? -1 : 1;
        add("ParamAngleX", 12 * dir * w2);
        add("ParamAngleZ", 4 * dir * w2);
        add("ParamEyeBallX", 0.8 * dir * w2);
      } else if (k === 3) {
        // 看右
        add("ParamAngleX", 10 * iw);
        add("ParamAngleZ", 4 * iw);
        add("ParamEyeBallX", 0.7 * iw);
      } else if (k === 4) {
        // 甩头发
        add("ParamHairFront", 1.6 * iw * Math.sin(this.idleP * Math.PI * 2));
        add("ParamHairSide", 1.3 * iw * Math.sin(this.idleP * Math.PI * 2));
        add("ParamAngleZ", 8 * iw);
      } else if (k === 5) {
        // 抬头后仰（该模型没有手臂参数，做成“伸展”感）
        add("ParamAngleY", 10 * iw);
        add("ParamBodyAngleX", -8 * iw);
        add("ParamAngleZ", -3 * iw);
        add("ParamMouthOpenY", 0.3 * iw);
      }
    }
  }

  playGobble() {
    if (!this.model) return;
    this.gobble = 1;
    this.tryMotion(["TapBody", "TapHead", "FlickHead", "Idle"]);
  }

  playClick() {
    if (!this.model) return;
    this.click = 1;
    this.tryMotion(["TapBody", "FlickHead", "Idle"]);
  }

  playAction(_id: string, _loop = false) {
    // PSD 动作库暂不支持标准 Live2D 后端（此处留空占位）
  }

  stopAction() {
    // 同上
  }

  private tryMotion(names: string[]) {
    const m = this.model;
    if (!m) return;
    for (const n of names) {
      try {
        m.motion(n);
        return;
      } catch {
        /* 该组不存在则换下一个 */
      }
    }
  }

  /** 切换模型自带表情（exp3.json 的 Name） */
  setModelExpression(name: string) {
    try {
      if (!name) {
        // 恢复默认表情：清掉当前 expression 的叠加
        const mgr = (this.model?.internalModel as unknown as {
          motionManager?: { expressionManager?: { resetExpression?: () => void } };
        })?.motionManager?.expressionManager;
        mgr?.resetExpression?.();
        return;
      }
      this.model?.expression(name);
    } catch (e) {
      l2dLog("setExpression failed: " + String(e));
    }
  }

  /** 菜单主动触发待机动作 */
  triggerIdle(kind: number) {
    this.idleKind = kind;
    this.idleClock = 0;
    this.idleDur = kind === 2 ? 3.2 : 2.0;
  }

  setSwayEnabled(on: boolean) {
    this.swayEnabled = on;
  }

  setScale(displayW: number) {
    this.displayW = Math.max(50, displayW);
    if (this.model) this.fit();
  }

  /**
   * 「调整模型边界」面板给的四边松紧（正=放大、负=收紧），默认全 0 = 和原来完全一致。
   * PSD 那条链路（Rigged2DView）早就有这个能力，标准 Live2D 以前只有 `?.` 空转，
   * 于是滑条拖了没反应 —— 两边现在行为一致。
   */
  private boundsPad = { left: 0, right: 0, top: 0, bottom: 0 };

  setBoundsPadding(p: { left: number; right: number; top: number; bottom: number }) {
    this.boundsPad = p;
  }

  /** 标准 Live2D 在 700×700 Pixi stage 内的真实可见 bounds。 */
  getCharacterBounds(): { left: number; top: number; right: number; bottom: number } | null {
    const m = this.model;
    if (!m || !m.parent) return null;
    const bounds = m.getBounds();
    const pad = this.boundsPad;
    const left = bounds.x - this.modelOffsetX - pad.left;
    const top = bounds.y - this.modelOffsetY - pad.top;
    const right = left + bounds.width + pad.left + pad.right;
    const bottom = top + bounds.height + pad.top + pad.bottom;
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
  }

  attachTo(_stage: HTMLElement, pixiStage: PIXI.Container) {
    pixiStage.addChild(this.container);
  }

  unmount() {
    this.container.destroy({ children: true });
  }
}
