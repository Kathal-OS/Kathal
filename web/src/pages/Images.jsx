import { useApi } from '../hooks/useApi'

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i]
}

export default function Images() {
  const { data: status } = useApi('/status')
  const { data: images, loading } = useApi('/images')

  const dockerAvailable = status?.dockerAvailable || false

  // Normalize response — handle both array and object.
  const imageList = Array.isArray(images) ? images : (images?.images || [])

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Images</h1>
        <p className="text-gray-500 mt-1">
          {dockerAvailable ? `${imageList.length} images installed` : 'Docker not available'}
        </p>
      </div>

      {!dockerAvailable ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <span className="text-6xl mb-4 block">📦</span>
          <h2 className="text-xl font-semibold mb-2">Docker Not Available</h2>
          <p className="text-gray-500">Install Docker to view and manage images.</p>
        </div>
      ) : loading ? (
        <div className="text-center py-12 text-gray-500">Loading images...</div>
      ) : imageList.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <span className="text-6xl mb-4 block">📦</span>
          <h2 className="text-xl font-semibold mb-2">No Images</h2>
          <p className="text-gray-500">Pull images with <code>docker pull</code> or deploy an app.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-800/50">
              <tr>
                <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Image</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Tag</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Size</th>
                <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Created</th>
              </tr>
            </thead>
            <tbody>
              {imageList.map((img) => {
                const tag = img.repoTags?.[0] || '<none>'
                const [repo, version] = tag.split(':')
                return (
                  <tr key={img.id} className="border-b border-gray-800 hover:bg-gray-900/50">
                    <td className="py-3 px-4">
                      <p className="font-medium">{repo}</p>
                    </td>
                    <td className="py-3 px-4">
                      <span className="bg-gray-800 rounded px-2 py-0.5 text-xs">
                        {version || 'latest'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-400">
                      {formatBytes(img.size)}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-500">
                      {new Date(img.created * 1000).toLocaleDateString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
