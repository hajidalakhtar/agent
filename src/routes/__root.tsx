import { Outlet, createRootRoute, Link } from '@tanstack/react-router'
import '../styles.css'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  return (
    <div className="min-h-screen bg-[var(--nb-bg)] text-black">
      <header className="sticky top-0 z-40 border-b-[3px] border-black bg-[#FFEB3B]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 sm:px-6 py-3">
          <Link to="/" className="flex items-center gap-2 cursor-pointer">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border-[3px] border-black bg-[#2196F3] shadow-[3px_3px_0_#000]">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="black" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                <path d="M3.3 7 12 12l8.7-5M12 22V12"/>
              </svg>
            </span>
            <span className="text-lg sm:text-xl font-extrabold tracking-tight">Sandbox Manager</span>
          </Link>
          <nav className="flex items-center gap-2 sm:gap-3 text-sm font-bold">
            <Link to="/" className="nb-btn !py-2 !px-3 bg-white [&.active]:bg-[#4ECDC4] cursor-pointer transition-all">
              Dashboard
            </Link>
            <Link to="/memories" className="nb-btn !py-2 !px-3 bg-white [&.active]:bg-[#4ECDC4] cursor-pointer transition-all">
              Otak
            </Link>
            <a href="/api/sandboxes" target="_blank" rel="noreferrer" className="nb-btn !py-2 !px-3 bg-white cursor-pointer transition-all">
              API
            </a>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-10">
        <Outlet />
      </main>
      <footer className="border-t-[3px] border-black bg-white mt-8">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between text-sm font-semibold">
          <div>© 2026 Sandbox Manager · Instabox & SSH control panel</div>
          <div className="flex flex-wrap gap-3">
            <a href="/api/events" target="_blank" rel="noreferrer" className="underline decoration-2 underline-offset-2 hover:bg-[#FFEB3B] px-1">Events</a>
            <a href="/api/webhooks/status" target="_blank" rel="noreferrer" className="underline decoration-2 underline-offset-2 hover:bg-[#FFEB3B] px-1">Webhooks</a>
            <a href="/api/vnc/active" target="_blank" rel="noreferrer" className="underline decoration-2 underline-offset-2 hover:bg-[#FFEB3B] px-1">VNC Active</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
