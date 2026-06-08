import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, FileSpreadsheet, CheckCircle, AlertCircle, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import clsx from 'clsx'

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function UploadPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [state, setState] = useState('idle') // idle | uploading | success | error
  const [result, setResult] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')

  const accept = '.xlsx,.xls,.xlsm'

  function pickFile(f) {
    if (!f) return
    const ext = f.name.split('.').pop().toLowerCase()
    if (!['xlsx', 'xls', 'xlsm'].includes(ext)) {
      setErrorMsg('Please select an Excel file (.xlsx, .xls, or .xlsm).')
      return
    }
    if (f.size > 10 * 1024 * 1024) {
      setErrorMsg('File must be under 10 MB.')
      return
    }
    setFile(f)
    setErrorMsg('')
    setState('idle')
  }

  const onDrop = useCallback((e) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files[0]
    pickFile(dropped)
  }, [])

  async function handleUpload() {
    if (!file) return
    setState('uploading')
    setErrorMsg('')

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      const base64 = await fileToBase64(file)

      const res = await fetch('/.netlify/functions/parse-timesheet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ file: base64, fileName: file.name }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')

      setResult(data)
      setState('success')
    } catch (err) {
      setErrorMsg(err.message)
      setState('error')
    }
  }

  if (state === 'success' && result) {
    const { timesheet, entries } = result
    return (
      <div className="max-w-lg mx-auto space-y-6">
        <div className="card p-8 text-center">
          <CheckCircle size={48} className="text-emerald-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-1">Timesheet submitted!</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Your manager has been notified and will review it shortly.
          </p>

          <div className="text-left bg-gray-50 dark:bg-gray-800 rounded-xl p-4 mb-6 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Date</span>
              <span className="font-medium">{timesheet.date}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Total hours</span>
              <span className="font-medium">{timesheet.total_hours}h</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Entries parsed</span>
              <span className="font-medium">{entries.length}</span>
            </div>
          </div>

          <div className="space-y-2 text-left mb-6">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Parsed entries</p>
            {entries.map((e, i) => (
              <div key={i} className="flex items-center justify-between text-sm bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
                <div>
                  <span className="font-medium">{e.project_name || '—'}</span>
                  {e.task && <span className="text-gray-400 ml-2 text-xs">· {e.task}</span>}
                </div>
                <span className="text-gray-500 text-xs">{e.time_from} – {e.time_to} ({e.hours_decimal}h)</span>
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <button onClick={() => { setFile(null); setState('idle'); setResult(null) }} className="btn-secondary flex-1">
              Upload another
            </button>
            <button onClick={() => navigate('/history')} className="btn-primary flex-1">
              View history
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Upload timesheet</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
          Upload your daily Excel timesheet file.
        </p>
      </div>

      <div className="card p-6 space-y-5">
        {/* Drop zone */}
        <div
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDragOver={e => e.preventDefault()}
          onDrop={onDrop}
          onClick={() => document.getElementById('file-input').click()}
          className={clsx(
            'border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all',
            dragging
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20'
              : file
              ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/20'
              : 'border-gray-300 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-600 hover:bg-gray-50 dark:hover:bg-gray-800/30'
          )}
        >
          <input
            id="file-input"
            type="file"
            accept={accept}
            className="hidden"
            onChange={e => pickFile(e.target.files[0])}
          />

          {file ? (
            <>
              <FileSpreadsheet size={36} className="text-emerald-500 mx-auto mb-3" />
              <p className="font-medium text-sm">{file.name}</p>
              <p className="text-xs text-gray-400 mt-1">{(file.size / 1024).toFixed(1)} KB · Click to change</p>
            </>
          ) : (
            <>
              <Upload size={36} className="text-gray-400 mx-auto mb-3" />
              <p className="font-medium text-sm">Drop your Excel file here</p>
              <p className="text-xs text-gray-400 mt-1">or click to browse · .xlsx, .xls, .xlsm · max 10 MB</p>
            </>
          )}
        </div>

        {/* Expected format hint */}
        <div className="bg-blue-50 dark:bg-blue-950/20 rounded-xl p-4">
          <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-2">Expected file format</p>
          <ul className="text-xs text-blue-600 dark:text-blue-400 space-y-1">
            <li>• Row near the top with a <strong>Date</strong> field (e.g. "Date: 2024-01-15")</li>
            <li>• Header row: <strong>Time</strong> | <strong>Project Name</strong> | <strong>Task</strong></li>
            <li>• Time format: <strong>9:00 - 17:00</strong>, <strong>9:00 AM to 5:00 PM</strong>, etc.</li>
          </ul>
        </div>

        {errorMsg && (
          <div className="flex items-start gap-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl p-4">
            <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700 dark:text-red-400">{errorMsg}</p>
            <button onClick={() => setErrorMsg('')} className="ml-auto text-red-400 hover:text-red-600">
              <X size={14} />
            </button>
          </div>
        )}

        <button
          onClick={handleUpload}
          disabled={!file || state === 'uploading'}
          className="btn-primary w-full"
        >
          {state === 'uploading' ? (
            <>
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Parsing & uploading…
            </>
          ) : (
            <>
              <Upload size={16} />
              Submit timesheet
            </>
          )}
        </button>
      </div>
    </div>
  )
}
