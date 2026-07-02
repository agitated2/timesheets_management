import { Outlet, useLocation } from 'react-router-dom'
import Navbar from './Navbar'

export default function Layout() {
  const location = useLocation()
  return (
    <div className="flex min-h-screen">
      <Navbar />
      <main className="flex-1 min-w-0 pt-14 lg:pt-0 px-4 sm:px-6 py-6 max-w-7xl mx-auto w-full">
        {/* key on pathname so the enter animation replays on every navigation */}
        <div key={location.pathname} className="page-enter">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
