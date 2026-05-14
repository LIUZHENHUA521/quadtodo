import React, { useCallback, useState } from 'react'
import hljs from 'highlight.js'
import './markdownComponents.css'

// react-markdown v9+ 移除了传给 `code` 组件的 `inline` 属性。判断块状/行内的
// 官方做法是按 markdown 规范的事实：块状代码会被 `<pre>` 包住，行内代码不会。
// 因此分别覆盖 `pre` 与 `code` 两个 slot 即可。

export function MarkdownPre({ children }: { children?: React.ReactNode }) {
  const first = React.Children.toArray(children)[0]
  if (!React.isValidElement(first)) {
    return (
      <div className="aq-md-code-block">
        <pre className="aq-md-code-pre hljs">{children}</pre>
      </div>
    )
  }
  const { className, children: codeContent } = (first as React.ReactElement<{ className?: string; children?: React.ReactNode }>).props
  const code = String(codeContent ?? '').replace(/\n$/, '')
  const lang = /language-(\w+)/.exec(className || '')?.[1]
  let html = ''
  try {
    html = lang && hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(code).value
  } catch {
    html = code
  }
  return (
    <div className="aq-md-code-block">
      <div className="aq-md-code-header">
        {lang && <span className="aq-md-code-lang">{lang}</span>}
        <CopyButton text={code} />
      </div>
      <pre className="aq-md-code-pre hljs">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard 不可用（http 非 localhost / 旧浏览器）静默失败 */
    }
  }, [text])
  return (
    <button
      type="button"
      className={`aq-md-code-copy${copied ? ' aq-md-code-copy--copied' : ''}`}
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy code'}
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}

export function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <code className={`aq-md-inline-code${className ? ` ${className}` : ''}`}>{children}</code>
}

export function MarkdownTable({ children }: { children?: React.ReactNode }) {
  return (
    <div className="aq-md-table-wrap">
      <table className="aq-md-table">{children}</table>
    </div>
  )
}

export const markdownComponents = {
  pre: MarkdownPre as any,
  code: MarkdownCode as any,
  table: MarkdownTable as any,
}
