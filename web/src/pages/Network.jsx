import { useState, useEffect } from 'react'
import { apiFetch, apiPost, apiDelete } from '../hooks/useApi'

export default function Network() {
  const [tab, setTab] = useState('networks')
  const [networks, setNetworks] = useState([])
  const [volumes, setVolumes] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateNetwork, setShowCreateNetwork] = useState(false)
  const [showCreateVolume, setShowCreateVolume] = useState(false)
  const [netForm, setNetForm] = useState({ name: '', driver: 'bridge', internal: false, attachable: true, enableIPv6: false })
  const [volForm, setVolForm] = useState({ name: '', driver: 'local' })

  useEffect(() => {
    loadData()
  }, [tab])

  async function loadData() {
    setLoading(true)
    try {
      if (tab === 'networks') {
        const data = await apiFetch('/api/v1/network')
        setNetworks(data || [])
      } else {
        const data = await apiFetch('/api/v1/volumes')
        setVolumes(data || [])
      }
    } catch (e) {
      console.error(e)
    }
    setLoading(false)
  }

  async function createNetwork() {
    try {
      await apiPost('/api/v1/network', netForm)
      setShowCreateNetwork(false)
      setNetForm({ name: '', driver: 'bridge', internal: false, attachable: true, enableIPv6: false })
      loadData()
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }

  async function createVolume() {
    try {
      await apiPost('/api/v1/volumes', volForm)
      setShowCreateVolume(false)
      setVolForm({ name: '', driver: 'local' })
      loadData()
    } catch (e) {
      alert('Failed: ' + e.message)
    }
  }

  async function deleteNetwork(name) {
    if (!confirm('Delete network "' + name + '"?')) return
    try {
      await apiDelete('/api/v1/network/' + name)
      loadData()
    } catch (e) {
      alert('Delete failed: ' + e.message)
    }
  }

  async function deleteVolume(name) {
    if (!confirm('Delete volume "' + name + '"?')) return
    try {
      await apiDelete('/api/v1/volumes/' + name)
      loadData()
    } catch (e) {
      alert('Delete failed: ' + e.message)
    }
  }

  async function pruneNetworks() {
    if (!confirm('Remove all unused networks?')) return
    try {
      await apiPost('/api/v1/network/prune')
      loadData()
    } catch (e) {
      alert('Prune failed: ' + e.message)
    }
  }

  async function pruneVolumes() {
    if (!confirm('Remove all unused volumes?')) return
    try {
      await apiPost('/api/v1/volumes/prune')
      loadData()
    } catch (e) {
      alert('Prune failed: ' + e.message)
    }
  }

  return (
    <div style={{ padding: 24 }}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: '#1e293b', padding: 4, borderRadius: 8 }}>
        <button onClick={() => setTab('networks')} style={tabStyle(tab === 'networks')}>
          🌐 Networks ({networks.length})
        </button>
        <button onClick={() => setTab('volumes')} style={tabStyle(tab === 'volumes')}>
          💾 Volumes ({volumes.length})
        </button>
      </div>

      {tab === 'networks' ? (
        <NetworksView
          networks={networks}
          loading={loading}
          onRefresh={loadData}
          onCreate={createNetwork}
          onDelete={deleteNetwork}
          showCreate={showCreateNetwork}
          setShowCreate={setShowCreateNetwork}
          form={netForm}
          setForm={setNetForm}
          onPrune={pruneNetworks}
        />
      ) : (
        <VolumesView
          volumes={volumes}
          loading={loading}
          onRefresh={loadData}
          onCreate={createVolume}
          onDelete={deleteVolume}
          showCreate={showCreateVolume}
          setShowCreate={setShowCreateVolume}
          form={volForm}
          setForm={setVolForm}
          onPrune={pruneVolumes}
        />
      )}
    </div>
  )
}

function tabStyle(active) {
  return {
    flex: 1,
    padding: '10px 16px',
    border: 'none',
    borderRadius: 6,
    background: active ? '#3b82f6' : 'transparent',
    color: active ? 'white' : '#94a3b8',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
    transition: 'all 0.2s'
  }
}

function NetworksView({ networks, loading, onRefresh, onCreate, onDelete, showCreate, setShowCreate, form, setForm, onPrune }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <button onClick={onRefresh} disabled={loading}
          style={{ padding: '8px 16px', background: '#334155', border: 'none', borderRadius: 6, color: '#94a3b8', cursor: 'pointer' }}>
          Refresh
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onPrune}
            style={{ padding: '8px 16px', background: '#ef4444', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 13 }}>
            Prune Unused
          </button>
          <button onClick={() => setShowCreate(true)}
            style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>
            + Create Network
          </button>
        </div>
      </div>

      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>Loading...</div>
        ) : networks.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#64748b' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🌐</div>
            <p>No networks found</p>
          </div>
        ) : (
          <div style={{ overflow: 'auto' }}>
            {networks.map(n => (
              <div key={n.id} style={{ display: 'flex', alignItems: 'center', padding: '16px', borderBottom: '1px solid #334155' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ background: '#0f172a', padding: '4px 10px', borderRadius: 6, fontSize: 13 }}>
                      {n.name}
                    </code>
                    <span style={{ background: n.internal ? '#ef4444' : '#22c55e', color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>
                      {n.driver}
                    </span>
                    {n.internal && <span style={{ background: '#f59e0b', color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>Internal</span>}
                    {n.attachable && <span style={{ background: '#8b5cf6', color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>Attachable</span>}
                    {n.ingress && <span style={{ background: '#06b6d4', color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>Ingress</span>}
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>
                    ID: {n.id} · Scope: {n.scope} · {n.containers?.length || 0} containers
                  </p>
                </div>
                <button onClick={() => deleteNetwork(n.name)}
                  style={{ padding: '6px 12px', background: '#ef4444', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 12 }}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setShowCreate(false)}>
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 16, padding: 32, width: 480, maxWidth: '90%' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 20px' }}>Create Network</h3>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Name</label>
              <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="my-network"
                style={{ width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13 }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Driver</label>
              <select value={form.driver} onChange={e => setForm({...form, driver: e.target.value})}
                style={{ width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13 }}>
                <option value="bridge">bridge</option>
                <option value="overlay">overlay</option>
                <option value="macvlan">macvlan</option>
                <option value="ipvlan">ipvlan</option>
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#94a3b8', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.internal} onChange={e => setForm({...form, internal: e.target.checked})} /> Internal
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#94a3b8', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.attachable} onChange={e => setForm({...form, attachable: e.target.checked})} /> Attachable
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#94a3b8', cursor: 'pointer' }}>
                <input type="checkbox" checked={form.enableIPv6} onChange={e => setForm({...form, enableIPv6: e.target.checked})} /> Enable IPv6
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowCreate(false)} style={{ padding: '8px 16px', background: '#334155', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>Cancel</button>
              <button onClick={onCreate} style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>Create</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function VolumesView({ volumes, loading, onRefresh, onCreate, onDelete, showCreate, setShowCreate, form, setForm, onPrune }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <button onClick={onRefresh} disabled={loading}
          style={{ padding: '8px 16px', background: '#334155', border: 'none', borderRadius: 6, color: '#94a3b8', cursor: 'pointer' }}>
          Refresh
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onPrune}
            style={{ padding: '8px 16px', background: '#ef4444', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 13 }}>
            Prune Unused
          </button>
          <button onClick={() => setShowCreate(true)}
            style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>
            + Create Volume
          </button>
        </div>
      </div>

      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>Loading...</div>
        ) : volumes.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#64748b' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>💾</div>
            <p>No volumes found</p>
          </div>
        ) : (
          <div style={{ overflow: 'auto' }}>
            {volumes.map(v => (
              <div key={v.name} style={{ display: 'flex', alignItems: 'center', padding: '16px', borderBottom: '1px solid #334155' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ background: '#0f172a', padding: '4px 10px', borderRadius: 6, fontSize: 13 }}>
                      {v.name}
                    </code>
                    <span style={{ background: '#3b82f6', color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>
                      {v.driver}
                    </span>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>
                    Mountpoint: {v.mountpoint} · Scope: {v.scope}
                  </p>
                </div>
                <button onClick={() => deleteVolume(v.name)}
                  style={{ padding: '6px 12px', background: '#ef4444', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer', fontSize: 12 }}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => setShowCreate(false)}>
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 16, padding: 32, width: 480, maxWidth: '90%' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 20px' }}>Create Volume</h3>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Name (optional)</label>
              <input value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder="auto-generated if empty"
                style={{ width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13 }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 4 }}>Driver</label>
              <select value={form.driver} onChange={e => setForm({...form, driver: e.target.value})}
                style={{ width: '100%', padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 13 }}>
                <option value="local">local</option>
                <option value="nfs">nfs</option>
                <option value="tmpfs">tmpfs</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowCreate(false)} style={{ padding: '8px 16px', background: '#334155', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>Cancel</button>
              <button onClick={onCreate} style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' }}>Create</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}