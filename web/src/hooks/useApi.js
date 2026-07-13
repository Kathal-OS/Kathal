import { useState, useEffect } from 'react'

// useApi fetches a GET endpoint with JWT auth from localStorage.
// Returns { data, loading, error } and re-fetches when the path changes.
export function useApi(path) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const token = localStorage.getItem('kathal_token')
    const headers = {}
    if (token) headers['Authorization'] = 'Bearer ' + token

    fetch('/api/v1' + path, { headers })
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(json => { if (!cancelled) setData(json) })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [path])

  return { data, loading, error }
}

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('kathal_token')
  const headers = { 'Content-Type': 'application/json', ...options.headers }
  if (token) headers['Authorization'] = 'Bearer ' + token

  const res = await fetch('/api/v1' + path, { ...options, headers })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
  return data
}

export async function apiFetchBlob(path, options = {}) {
  const token = localStorage.getItem('kathal_token')
  const headers = { ...options.headers }
  if (token) headers['Authorization'] = 'Bearer ' + token

  const res = await fetch('/api/v1' + path, { ...options, headers })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.blob()
}

export async function apiFetchText(path, options = {}) {
  const token = localStorage.getItem('kathal_token')
  const headers = { ...options.headers }
  if (token) headers['Authorization'] = 'Bearer ' + token

  const res = await fetch('/api/v1' + path, { ...options, headers })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.text()
}

export async function apiPostFormData(path, formData, options = {}) {
  const token = localStorage.getItem('kathal_token')
  const headers = { ...options.headers }
  if (token) headers['Authorization'] = 'Bearer ' + token

  const res = await fetch('/api/v1' + path, {
    ...options,
    method: 'POST',
    headers,
    body: formData
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
  return data
}

export async function apiPost(path, body) {
  return apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
}

export async function apiDelete(path) {
  return apiFetch(path, { method: 'DELETE' })
}