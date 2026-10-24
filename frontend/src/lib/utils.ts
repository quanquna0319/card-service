import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 用临时文本框选中并执行 execCommand("copy")。
 *
 * 手机浏览器经 http://内网IP 访问时不是安全上下文，没有 navigator.clipboard，
 * 只能走这条回退路径，因此下面几点缺一不可：
 * - 文本框不能是 readonly：iOS Safari 对只读文本框建立不了选区，
 *   execCommand 照样返回 true，剪贴板里却是空的（表现为提示已复制、粘贴却没有内容）。
 * - 字号保持 16px，否则 iOS 聚焦时会自动放大页面，选区随之丢失。
 * - 宿主优先用当前弹窗：对话框打开时页面其余部分被 aria-hidden 且有焦点锁，
 *   插到 body 上的临时节点既拿不到焦点，操作也可能被拒绝。
 * - 复制后再延后一拍移除节点，部分 iOS 版本同步移除会让复制失效。
 */
function copyBySelection(text: string): boolean {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  const host: HTMLElement = dialog ?? document.body
  const area = document.createElement("textarea")
  area.value = text
  area.readOnly = false
  area.contentEditable = "true"
  area.tabIndex = -1
  area.setAttribute("aria-hidden", "true")
  area.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "width:1px",
    "height:1px",
    "padding:0",
    "border:0",
    "outline:none",
    "background:transparent",
    "color:transparent",
    "font-size:16px",
    "line-height:1",
    "opacity:0",
    "z-index:-1",
  ].join(";")

  const previousActive = document.activeElement as HTMLElement | null
  host.append(area)

  let copied = false
  try {
    area.focus({ preventScroll: true })
    area.select()
    area.setSelectionRange(0, text.length)
    const range = document.createRange()
    range.selectNodeContents(area)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    copied = document.execCommand("copy")
  } catch {
    copied = false
  } finally {
    window.setTimeout(() => {
      window.getSelection()?.removeAllRanges()
      area.remove()
      previousActive?.focus?.({ preventScroll: true })
    }, 80)
  }
  return copied
}

/**
 * 复制文本。安全上下文（https / localhost）优先用异步剪贴板接口，
 * 其余情况回退到 execCommand；两条路都失败时返回 false，由调用方提示手动复制。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false

  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* 继续走回退路径 */
    }
  }

  return copyBySelection(text)
}