import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Surface in console for debugging
    console.error('Render error:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50 dark:bg-gray-950">
          <div className="max-w-lg w-full card p-6 space-y-3">
            <h1 className="text-lg font-semibold text-red-600 dark:text-red-400">Something went wrong</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              The page failed to render. The error below helps pinpoint the cause:
            </p>
            <pre className="text-xs bg-gray-100 dark:bg-gray-900 rounded-md p-3 overflow-auto whitespace-pre-wrap text-red-700 dark:text-red-300">
              {String(this.state.error?.message || this.state.error)}
            </pre>
            <button onClick={() => window.location.reload()} className="btn-secondary text-sm">
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
