import { useState, useEffect } from 'react'

// Optional Bearer token kept strictly in JS memory; HttpOnly kathal_session cookie
// also authenticates requests seamlessly via credentials: 'same-origin'.
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

export function hasPermission(user, permission) {
  if (!permission) return true
  if (!user || !Array.isArray(user.permissions)) return false
  return user.permissions.includes(permission)
}

export function hasAnyPermission(user, permissions = []) {
  if (!permissions.length) return true
  return permissions.some((p) => hasPermission(user, p))
}

export function hasRole(user, roleName) {
  if (!user) return false
  if (Array.isArray(user.roles) && user.roles.includes(roleName)) return true
  return user.role === roleName
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

function buildAuthHeaders(extraHeaders = {}, includeJson = false) {
  const headers = {
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    'X-Requested-With': 'XMLHttpRequest',
    ...extraHeaders,
  }
  if (memoryToken) headers['Authorization'] = 'Bearer ' + memoryToken
  return headers
}

// useApi fetches a GET endpoint using in-memory Bearer auth or HttpOnly session cookie.
export function useApi(path) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetch(buildApiUrl(path), {
      headers: buildAuthHeaders(),
      credentials: 'same-origin',
    })
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
  const headers = buildAuthHeaders(options.headers, true)

  const res = await fetch(buildApiUrl(path), {
    credentials: 'same-origin',
    ...options,
    headers,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    notifyIfSessionInvalid(res.status, data?.error)
    const err = new Error(data.error || 'HTTP ' + res.status)
    err.status = res.status
    err.requiredPermission = data.requiredPermission
    throw err
  }
  return data
}

export async function apiFetchBlob(path, options = {}) {
  const headers = buildAuthHeaders(options.headers, false)

  const res = await fetch(buildApiUrl(path), {
    credentials: 'same-origin',
    ...options,
    headers,
  })
  if (!res.ok) {
    const serverErr = await parseErrorBody(res)
    notifyIfSessionInvalid(res.status, serverErr)
    throw new Error(serverErr || 'HTTP ' + res.status)
  }
  return res.blob()
}

export async function apiFetchText(path, options = {}) {
  const headers = buildAuthHeaders(options.headers, false)

  const res = await fetch(buildApiUrl(path), {
    credentials: 'same-origin',
    ...options,
    headers,
  })
  if (!res.ok) {
    const serverErr = await parseErrorBody(res)
    notifyIfSessionInvalid(res.status, serverErr)
    throw new Error(serverErr || 'HTTP ' + res.status)
  }
  return res.text()
}

export async function apiPostFormData(path, formData, options = {}) {
  const headers = buildAuthHeaders(options.headers, false)

  const res = await fetch(buildApiUrl(path), {
    credentials: 'same-origin',
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
  return apiFetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
}

export async function apiPut(path, body) {
  return apiFetch(path, { method: 'PUT', body: JSON.stringify(body ?? {}) })
}

export async function apiPatch(path, body) {
  return apiFetch(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) })
}

export async function apiDelete(path) {
  return apiFetch(path, { method: 'DELETE' })
}

export async function logoutSession() {
  try {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: buildAuthHeaders({}, true),
      credentials: 'same-origin',
      body: '{}',
    })
  } catch {
    // ignore network error during sign-out cleanup
  } finally {
    clearAuthToken()
  }
}