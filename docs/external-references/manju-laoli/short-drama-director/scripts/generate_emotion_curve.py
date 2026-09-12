#!/usr/bin/env python3
import sys
import os
import matplotlib
import matplotlib.pyplot as plt

# ── 中文字体检测与配置（macOS/常见 Linux 路径回退）──
def _setup_cjk_font():
    """为 matplotlib 配置可用的中文字体，避免图形中文变方块。"""
    candidates = [
        "/System/Library/Fonts/Hiragino Sans GB.ttc",   # macOS
        "/System/Library/Fonts/STHeiti Light.ttc",       # macOS
        "/System/Library/Fonts/Supplemental/Songti.ttc", # macOS
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",  # Linux
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",          # Linux
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                from matplotlib import font_manager
                font_manager.fontManager.addfont(path)
                name = font_manager.FontProperties(fname=path).get_name()
                matplotlib.rcParams["font.family"] = name
                matplotlib.rcParams["axes.unicode_minus"] = False
                return name
            except Exception:
                continue
    return None

_setup_cjk_font()

def plot_emotion_curve(beats=None, output_png="emotion_beat_curve.png"):
    """
    绘制 12 节拍短剧全片情绪张力曲线
    """
    if beats is None:
        beats = [
            ("1.起势", 3.5),
            ("2.冲突", 5.0),
            ("3.硬刚", 6.5),
            ("4.对峙", 7.2),
            ("5.蓄势", 4.2),
            ("6.危机", 8.2),
            ("7.高潮", 9.0),
            ("8.绝境", 6.2),
            ("9.反杀", 9.6),
            ("10.终局", 8.0),
            ("11.余波", 7.2),
            ("12.收尾", 4.5)
        ]
    
    names = [b[0] for b in beats]
    scores = [b[1] for b in beats]
    
    plt.figure(figsize=(10, 5), dpi=150)
    plt.plot(range(1, 13), scores, marker="o", color="#C23B22", linewidth=2.5, markersize=8)
    
    for i, (name, val) in enumerate(beats):
        plt.text(i+1, val+0.25, f"{val}\n{name}", ha="center", fontsize=9, fontweight="bold")
        
    plt.axhspan(8.5, 10.0, color="#C23B22", alpha=0.15, label="高潮/反杀区")
    plt.axhspan(6.5, 8.5, color="#E67E22", alpha=0.10, label="动作/对峙区")
    plt.axhspan(0, 6.5, color="#3498DB", alpha=0.08, label="发展/蓄势区")
    
    plt.title("短剧全片 12 节拍情绪张力曲线 (Emotion Beat Curve)", fontsize=14, fontweight="bold", pad=15)
    plt.xlabel("节拍序号 (Beat Index)", fontsize=11)
    plt.ylabel("戏剧张力 / 情绪值 (0~10)", fontsize=11)
    plt.ylim(0, 11)
    plt.xticks(range(1, 13))
    plt.grid(True, linestyle="--", alpha=0.6)
    plt.legend(loc="upper left")
    plt.tight_layout()
    plt.savefig(output_png)
    print(f"[+] Emotion curve saved successfully to: {output_png}")

if __name__ == "__main__":
    out_file = sys.argv[1] if len(sys.argv) > 1 else "emotion_beat_curve.png"
    plot_emotion_curve(output_png=out_file)
