#!/bin/bash
# 安卓模拟器 UI 驱动（纯 bash，绕开 Node spawnSync 在沙箱里的 EBUSY 限制）。
# 坐标来自 uiautomator 层级 dump，不再手算截图缩放。
#   ./scripts/ui.sh dump              列出可点元素中心坐标
#   ./scripts/ui.sh tap "聊天" [n]     按文本点击（n 为重复时的第几个，从 0 起）
#   ./scripts/ui.sh type "10.0.2.2"   输入文本
#   ./scripts/ui.sh key back|esc|enter|del
#   ./scripts/ui.sh shot out.png      截图
#   ./scripts/ui.sh cat               打印当前界面全部文本
ADB="${ADB:-/c/Users/User/AppData/Local/Android/Sdk/platform-tools/adb.exe}"
SERIAL="${ANDROID_SERIAL:-emulator-5554}"
# 关键：Git Bash 会把设备端路径 /sdcard/ui.xml 当成 MSYS 路径改写成
# C:/Users/.../PortableGit/sdcard/ui.xml，导致 uiautomator 写到假路径上。
# 关掉路径转换，原样透传给设备。
export MSYS_NO_PATHCONV=1
A(){ "$ADB" -s "$SERIAL" "$@"; }

dump_nodes(){
  A shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  A exec-out cat /sdcard/ui.xml
}

case "$1" in
  dump|cat)
    XML=$(dump_nodes)
    if [ "$1" = cat ]; then
      echo "$XML" | grep -oE 'text="[^"]+"' | sed 's/text="//;s/"$//' | grep -v '^$'
    else
      echo "$XML" | python -c "
import re,sys
xml=sys.stdin.read()
for m in re.finditer(r'<node[^>]*>', xml):
    tag=m.group(0)
    t=re.search(r'text=\"([^\"]*)\"',tag); b=re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"',tag)
    if not (t and b): continue
    txt=t.group(1).replace(chr(10),' / ')
    if not txt.strip(): continue
    x1,y1,x2,y2=map(int,b.groups())
    ck='*' if 'clickable=\"true\"' in tag else ' '
    print(f'{ck} {txt[:26]:28s} cx={(x1+x2)//2:5d} cy={(y1+y2)//2:5d}')
"
    fi
    ;;
  tap)
    NEEDLE="$2"; IDX="${3:-0}"
    XML=$(dump_nodes)
    COORD=$(echo "$XML" | python -c "
import re,sys
xml=sys.stdin.read(); needle=sys.argv[1]; idx=int(sys.argv[2])
hits=[]
for m in re.finditer(r'<node[^>]*>', xml):
    tag=m.group(0)
    t=re.search(r'text=\"([^\"]*)\"',tag)
    if not t or needle not in t.group(1): continue
    b=re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"',tag)
    if not b: continue
    x1,y1,x2,y2=map(int,b.groups())
    hits.append(((x1+x2)//2,(y1+y2)//2,'clickable=\"true\"' in tag))
if not hits: print(''); sys.exit(0)
cl=[h for h in hits if h[2]] or hits
pick=cl[idx] if idx<len(cl) else hits[idx]
print(f'{pick[0]} {pick[1]}')
" "$NEEDLE" "$IDX")
    if [ -z "$COORD" ]; then echo "未找到「$NEEDLE」" >&2; exit 2; fi
    A shell input tap $COORD
    echo "TAP \"$NEEDLE\" -> ($COORD)"
    ;;
  type)
    ESC=$(printf '%s' "$2" | sed "s/ /%s/g")
    A shell input text "$ESC"
    echo "TYPE \"$2\""
    ;;
  key)
    case "$2" in
      back) K=4;; home) K=3;; enter) K=66;; esc) K=111;; del) K=67;; tab) K=61;; *) K="$2";;
    esac
    A shell input keyevent "$K"; echo "KEY $2"
    ;;
  shot)
    A exec-out screencap -p > "$2"; echo "SHOT $2"
    ;;
  *) echo "用法: ui.sh dump|cat|tap <文本> [序号]|type <文本>|key <键>|shot <路径>" >&2; exit 1;;
esac
