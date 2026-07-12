import { useState, useEffect } from 'react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

export default function Env() {
  const [globalEnv, setGlobalEnv] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ key: '', value: '', description: '', secret: false })

  useEffect(() => {
    loadEnv()
  }, [])

  async function loadEnv() {
    setLoading(true)
    try {
      const data = await apiFetch('/api/v1/env')
      setGlobalEnv(data || [])
    } catch (e) {
      console.error(e)
    }
    setLoading(false)
  }

  async function handleAdd() {
    try {
      await apiPost('/api/v1/env', form)
      setShowAdd(false)
      setForm({ key: '', value: '', description: '', secret: false })
      loadEnv()
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }

  async function handleDelete(key) {
    if (!confirm('Delete environment variable "' + key + '"?')) return
    try {
      await apiDelete('/api/v1/env/' + key)
      loadEnv()
    } catch (e) {
      alert('Delete failed: ' + e.message)
    }
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>Environment Variables</h2>
        <button onClick={() => { setForm({ key: '', value: '', description: '', secret: false }); setShowAdd(true) }}
          style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>
          + Add Variable
        </button>
      </div>

      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: 16, borderBottom: '1px solid #334155', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ background: '#3b82f6', color: 'white', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            Global ({globalEnv.length})
          </span>
          <span style={{ color: '#94a3b8', fontSize: 13 }}>
            Applied to all containers on deploy
          </span>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>Loading...</div>
        ) : globalEnv.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#64748b' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔐</div>
            <p>No global environment variables</p>
            <p style={{ fontSize: 13 }}>Add variables to inject into all containers</p>
          </div>
        ) : (
          <div style={{ overflow: 'auto' }}>
            {globalEnv.map((env, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #334155' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ background: '#0f172a', padding: '2px 8px', borderRadius: 4, fontSize: 13 }}>
                      {env.key}
                    </code>
                    {env.secret && <span style={{ background: '#ef4444', color: 'white', padding: '2px 6px', borderRadius: 4, fontSize: 10 }}>SECRET</span>}
                  </div>
                  {env.description && <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>{env.description}</p>}
                </div>
                <code style={{ background: '#0f172a', padding: '4px 8px', borderRadius: 4, fontSize: 12, color: '#94a3b8', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                  {env.secret ? '••••••••' : env.value}
                </code>
                <button onClick={() => handleDelete(env.key)}
                  style={{ marginLeft: 12, padding: '6px 10px', background: '#ef4444', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 12 }}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add Modal */}
        {showAdd && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setShowAdd(false)}>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 16, padding: 32, width: 480, maxWidth: '90%' }} onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 20px' }}>Add Environment Variable</h3>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Key</label>
                <input value={form.key} onChange={e => setForm({...form, key: e.target.value})} placeholder="DATABASE_URL"
                  style={{ width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13 }} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Value</label>
                <input value={form.value} onChange={e => setForm({...form, value: e.target.value})} placeholder="postgresql://..."
                  style={{ width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13 }} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Description (optional)</label>
                <input value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Production database URL"
                  style={{ width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13 }} />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#94a3b8', marginBottom: 16, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.secret} onChange={e => setForm({...form, secret: e.target.checked})} />
                Mark as secret (hidden in UI)
              </label>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowAdd(false)} style={{ padding: '8px 16px', background: '#334155', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>Cancel</button>
                <button onClick={handleAdd} style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>Add</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}