import { useState } from 'react'
import { MonitorDown, X, CheckCircle2, Terminal, Laptop, Copy, Check } from 'lucide-react'
import { usePWAInstall } from '../hooks/usePWAInstall'

export default function PWAInstallButton({ compact = false }) {
  const { canInstall, isInstalled, platform, promptInstall } = usePWAInstall()
  const [showGuide, setShowGuide] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState(false)

  if (isInstalled && compact) {
    return null
  }

  async function handleClick() {
    if (canInstall) {
      const outcome = await promptInstall()
      if (outcome !== 'accepted') {
        setShowGuide(true)
      }
      return
    }
    setShowGuide(true)
  }

  function copyDesktopCommand() {
    navigator.clipboard?.writeText('npm run desktop')
    setCopiedCmd(true)
    setTimeout(() => setCopiedCmd(false), 1500)
  }

  return (
    <>
      {compact ? (
        <button
          type="button"
          onClick={handleClick}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-900/90 hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 transition-colors"
        >
          <span className="flex items-center gap-2 truncate">
            <MonitorDown className="w-3.5 h-3.5 text-kathal-400 shrink-0" />
            <span className="truncate">{canInstall ? 'Install Desktop App' : 'Desktop App'}</span>
          </span>
          <span className="text-[10px] font-mono text-slate-400 shrink-0">PWA</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          disabled={isInstalled}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-kathal-600 hover:bg-kathal-500 text-white text-sm font-medium whitespace-nowrap shrink-0 transition-colors disabled:opacity-50"
        >
          {isInstalled ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-green-300" />
              <span>Running in Desktop Window</span>
            </>
          ) : (
            <>
              <MonitorDown className="w-4 h-4" />
              <span>{canInstall ? 'Install Desktop App' : 'Open Desktop Install Guide'}</span>
            </>
          )}
        </button>
      )}

      {showGuide && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setShowGuide(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-[#101A10] border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-kathal-600/15 border border-kathal-500/30 flex items-center justify-center text-kathal-400 shrink-0">
                  <Laptop className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-100">KATHAL Desktop App Support</h2>
                  <p className="text-xs text-slate-400">
                    Install as a standalone desktop window or run the Electron native launcher
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Close desktop guide"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-300">
              <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-1.5">
                <p className="font-semibold text-slate-100">Option 1 — Install via Browser (Zero Extra Dependencies)</p>
                {platform === 'ios' ? (
                  <p className="text-slate-400 leading-relaxed">
                    Tap the Share button in Safari and select <span className="text-slate-200 font-medium">Add to Home Screen</span> to launch KATHAL full-screen.
                  </p>
                ) : platform === 'macos' ? (
                  <p className="text-slate-400 leading-relaxed">
                    In Chrome or Edge, click the <span className="text-slate-200 font-medium">Install KATHAL</span> icon in the address bar. In Safari 17+, choose <span className="text-slate-200 font-medium">File → Add to Dock</span>.
                  </p>
                ) : (
                  <p className="text-slate-400 leading-relaxed">
                    In Chrome or Edge on Windows/Linux, click the <span className="text-slate-200 font-medium">Install app</span> icon in the address bar (or menu → Save and Share → Install KATHAL) to create a dedicated desktop window and taskbar icon.
                  </p>
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2">
                <div className="flex items-center gap-2">
                  <Terminal className="w-3.5 h-3.5 text-kathal-400" />
                  <p className="font-semibold text-slate-100">Option 2 — Native Electron Desktop Window</p>
                </div>
                <p className="text-slate-400 leading-relaxed">
                  Launch the bundled <code className="text-slate-200">electron/main.cjs</code> desktop shell directly from the workspace root:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 font-mono text-slate-200">
                    npm run desktop
                  </code>
                  <button
                    type="button"
                    onClick={copyDesktopCommand}
                    className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 shrink-0"
                  >
                    {copiedCmd ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedCmd ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
