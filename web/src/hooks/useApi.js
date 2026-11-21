import { useState, useEffect } from 'react'

// Session token is held strictly in JS memory (never localStorage/sessionStorage)
let memoryToken = null
let unauthorizedHandler = null

export function setAuthToken(token) {
  memoryToken = token || null
}

export function getAuthToken() {
  return memoryToken
}

export function clearAuthToken() {
  memoryToken = null
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === 'function' ? handler : null
}

function buildApiUrl(path) {
  if (path.startsWith('/api/v1')) return path
  return '/api/v1' + (path.startsWith('/') ? path : '/' + path)
}

function notifyIfSessionInvalid(status, errorMessage) {
  if (status !== 401) return
  const msg = String(errorMessage || '').toLowerCase()
  if (!msg || msg === 'invalid token' || msg === 'unauthorized') {
    memoryToken = null
    if (unauthorizedHandler) {
      unauthorizedHandler('Your session expired or the server restarted. Please sign in again.')
    }
  }
}

async function parseErrorBody(res) {
  try {
    const data = await res.json()
    return data?.error || ''
  } catch {
    return ''
  }
}

// useApi fetches a GET endpoint with in-memory Bearer auth.
// Returns { data, loading, error } and re-fetches when the path changes.
export function useApi(path) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const headers = {}
    if (memoryToken) headers['Authorization'] = 'Bearer ' + memoryToken

    fetch(buildApiUrl(path), { headers })
      .then(async (res) => {
        if (!res.ok) {
          const serverErr = await parseErrorBody(res)
          notifyIfSessionInvalid(res.status, serverErr)
          throw new Error(serverErr || 'HTTP ' + res.status)
        }
        return res.json()
      })
      .then((json) => { if (!cancelled) setData(json) })
      .catch((err) => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [path])

  return { data, loading, error }
}

export async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers }
  if (memoryToken) headers['Authorization'] = 'Bearer ' + memoryToken

  const res = await fetch(buildApiUrl(path), { ...options, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    notifyIfSessionInvalid(res.status, data?.error)
    throw new Error(data.error || 'HTTP ' + res.status)
  }
  return data
}

export async function apiFetchBlob(path, options = {}) {
  const headers = { ...options.headers }
  if (memoryToken) headers['Authorization'] = 'Bearer ' + memoryToken

  const res = await fetch(buildApiUrl(path), { ...options, headers })
  if (!res.ok) {
    const serverErr = await parseErrorBody(res)
    notifyIfSessionInvalid(res.status, serverErr)
    throw new Error(serverErr || 'HTTP ' + res.status)
  }
  return res.blob()
}

export async function apiFetchText(path, options = {}) {
  const headers = { ...options.headers }
  if (memoryToken) headers['Authorization'] = 'Bearer ' + memoryToken

  const res = await fetch(buildApiUrl(path), { ...options, headers })
  if (!res.ok) {
    const serverErr = await parseErrorBody(res)
    notifyIfSessionInvalid(res.status, serverErr)
    throw new Error(serverErr || 'HTTP ' + res.status)
  }
  return res.text()
}

export async function apiPostFormData(path, formData, options = {}) {
  const headers = { ...options.headers }
  if (memoryToken) headers['Authorization'] = 'Bearer ' + memoryToken

  const res = await fetch(buildApiUrl(path), {
    ...options,
    method: 'POST',
    headers,
    body: formData,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    notifyIfSessionInvalid(res.status, data?.error)
    throw new Error(data.error || 'HTTP ' + res.status)
  }
  return data
}

export async function apiPost(path, body) {
  return apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
}

export async function apiPut(path, body) {
  return apiFetch(path, { method: 'PUT', body: JSON.stringify(body) })
}

export async function apiDelete(path) {
  return apiFetch(path, { method: 'DELETE' })
}