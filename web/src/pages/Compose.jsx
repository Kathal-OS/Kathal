import { useState, useEffect } from 'react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

const COMPOSE_PLACEHOLDER = `version: '3.8'
services:
  web:
    image: nginx
    ports:
      - "80:80"`

export default function Compose() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [selectedProject, setSelectedProject] = useState(null)
  const [form, setForm] = useState({ name: '', config: '' })
  const [deploying, setDeploying] = useState(null)

  useEffect(() => {
    loadProjects()
  }, [])

  async function loadProjects() {
    setLoading(true)
    try {
      const data = await apiFetch('/api/v1/compose')
      setProjects(data || [])
    } catch (e) {
      console.error(e)
    }
    setLoading(false)
  }

  async function handleAdd() {
    try {
      await apiPost('/api/v1/compose', form)
      setShowAdd(false)
      setForm({ name: '', config: '' })
      loadProjects()
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }

  async function handleUpdate() {
    try {
      await apiPost(`/api/v1/compose/${selectedProject.name}`, { config: form.config })
      setShowEdit(false)
      loadProjects()
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }

  async function handleDeploy(name) {
    setDeploying(name)
    try {
      await apiPost(`/api/v1/compose/${name}/deploy`)
      loadProjects()
    } catch (e) {
      alert('Deploy failed: ' + e.message)
    }
    setDeploying(null)
  }

  async function handleStop(name) {
    try {
      await apiPost(`/api/v1/compose/${name}/stop`)
      loadProjects()
    } catch (e) {
      alert('Stop failed: ' + e.message)
    }
  }

  async function handleDelete(name) {
    if (!confirm('Delete project "' + name + '"?')) return
    try {
      await apiDelete(`/api/v1/compose/${name}`)
      loadProjects()
    } catch (e) {
      alert('Delete failed: ' + e.message)
    }
  }

  function editProject(p) {
    setSelectedProject(p)
    setForm({ name: p.name, config: p.config || '' })
    setShowEdit(true)
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>Docker Compose</h2>
        <button onClick={() => { setForm({ name: '', config: '' }); setShowAdd(true) }}
          style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>
          + New Project
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: '#64748b', padding: 40 }}>Loading...</div>
      ) : projects.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#64748b' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
          <p>No Compose projects yet</p>
          <p style={{ fontSize: 13 }}>Create a project to manage multi-container applications</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {projects.map(p => (
            <div key={p.name} style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <h3 style={{ margin: '0 0 4px' }}>{p.name}</h3>
                  <p style={{ margin: 0, color: '#94a3b8', fontSize: 13 }}>{p.workingDir}</p>
                </div>
                <span style={{
                  padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                  background: p.status === 'running' ? '#22c55e' : p.status === 'deploying' ? '#eab308' : '#64748b',
                  color: 'white'
                }}>
                  {p.status || 'unknown'}
                </span>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {p.services?.length > 0 && (
                  <span style={{ background: '#0f172a', padding: '4px 10px', borderRadius: 6, fontSize: 12, color: '#94a3b8' }}>
                    {p.services.length} services
                  </span>
                )}
                <span style={{ background: '#0f172a', padding: '4px 10px', borderRadius: 6, fontSize: 12, color: '#94a3b8' }}>
                  Updated: {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : 'never'}
                </span>
              </div>

              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => handleDeploy(p.name)} disabled={deploying === p.name}
                  style={{ padding: '6px 12px', background: deploying === p.name ? '#1e40af' : '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: deploying === p.name ? 'wait' : 'pointer', fontSize: 13 }}>
                  {deploying === p.name ? 'Deploying...' : 'Deploy'}
                </button>
                <button onClick={() => handleStop(p.name)}
                  style={{ padding: '6px 12px', background: '#64748b', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 13 }}>
                  Stop
                </button>
                <button onClick={() => editProject(p)}
                  style={{ padding: '6px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 13 }}>
                  Edit
                </button>
                <button onClick={() => handleDelete(p.name)}
                  style={{ padding: '6px 12px', background: '#ef4444', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 13 }}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Modal */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setShowAdd(false)}>
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 16, padding: 32, width: 600, maxWidth: '90%' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 20px' }}>New Compose Project</h3>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Project Name</label>
              <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="my-app"
                style={{ width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13 }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>docker-compose.yml</label>
              <textarea value={form.config} onChange={e => setForm({...form, config: e.target.value})} rows={15}
                placeholder={COMPOSE_PLACEHOLDER}
                style={{ width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 12, fontFamily: 'monospace' }} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAdd(false)} style={{ padding: '8px 16px', background: '#334155', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleAdd} style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEdit && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setShowEdit(false)}>
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 16, padding: 32, width: 600, maxWidth: '90%' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 20px' }}>Edit: {selectedProject?.name}</h3>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>docker-compose.yml</label>
              <textarea value={form.config} onChange={e => setForm({...form, config: e.target.value})} rows={20}
                style={{ width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 12, fontFamily: 'monospace' }} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowEdit(false)} style={{ padding: '8px 16px', background: '#334155', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleUpdate} style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}