import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

// 页面列表
const pages = [
  { id: 'dash', label: '总览', icon: '◉', color: '#2f6bff' },
  { id: 'nodes', label: '节点', icon: '▢', color: '#22c7ee' },
  { id: 'network', label: '网络', icon: '◈', color: '#7c3aed' },
  { id: 'traffic', label: '流量', icon: '◫', color: '#10b981' },
  { id: 'enhance', label: '增强', icon: '⚡', color: '#f59e0b' },
  { id: 'diagnose', label: '诊断', icon: '✓', color: '#f97316' },
  { id: 'logs', label: '日志', icon: '☰', color: '#64748b' },
  { id: 'backup', label: '备份', icon: '⟳', color: '#8b5cf6' },
  { id: 'settings', label: '设置', icon: '⚙', color: '#94a3b8' },
]

// Toast 组件
const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const t = setTimeout(onClose, 3000)
    return () => clearTimeout(t)
  }, [onClose])
  const colors = { success: '#10b981', error: '#ef4444', info: '#2f6bff' }
  return (
    <div className="toast" style={{ '--toast-color': colors[type] }}>
      <span className="toastIcon">{type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}</span>
      <span className="toastText">{message}</span>
    </div>
  )
}

// 骨架屏组件
const Skeleton = ({ w = '100%', h = '16px', r = '8px' }) => (
  <div className="skeleton" style={{ width: w, height: h, borderRadius: r }} />
)

// 迷你图表组件
const MiniSparkline = ({ data = [], color = '#2f6bff', height = 40 }) => {
  const max = Math.max(...data, 1)
  const points = data.map((v, i) => `${(i / Math.max(data.length - 1, 1)) * 100},${100 - (v / max) * 100}`).join(' ')
  return (
    <svg width="100%" height={height} viewBox="0 0 100 100" preserveAspectRatio="none">
      <defs>
        <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,100 ${points} 100,100`} fill="url(#grad)" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  )
}

// 快捷操作按钮组件
const QuickAction = ({ icon, label, onClick, color, variant = 'default' }) => (
  <button className={`quickAction ${variant}`} onClick={onClick} style={{ '--accent': color }}>
    <span className="quickIcon">{icon}</span>
    <span className="quickLabel">{label}</span>
  </button>
)

// 节点卡片组件（增强版）
const NodeCardEnhanced = ({ node, isActive, onActivate, onEdit, onDelete }) => {
  const [isHovered, setIsHovered] = useState(false)
  const statusColors = { alive: '#10b981', dead: '#ef4444', unknown: '#94a3b8' }
  const statusLabels = { alive: '在线', dead: '离线', unknown: '未知' }

  return (
    <div 
      className={`card nodeCard ${isActive ? 'active' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="nodeCardHead">
        <div className="nodeCardIcon" style={{ background: isActive ? 'linear-gradient(135deg, #2f6bff, #22c7ee)' : '#f1f5f9' }}>
          <span>{node.protocol?.toUpperCase()?.slice(0, 3) || '✈'}</span>
        </div>
        <div className="nodeCardInfo">
          <b className="nodeCardName">{node.remark || '未命名节点'}</b>
          <span className="nodeCardAddr">{node.addr}:{node.port}</span>
        </div>
        {isHovered && (
          <div className="nodeCardActions">
            <button className="btn ghost sm" onClick={onEdit}>编辑</button>
            <button className="btn ghost sm danger" onClick={onDelete}>删除</button>
          </div>
        )}
        {!isHovered && (
          <span className="nodeBadge" style={{ background: statusColors[node.health || 'unknown'] }}>
            {statusLabels[node.health || 'unknown']}
          </span>
        )}
      </div>
      <div className="nodeCardMeta">
        <span>延迟: {node.ping || '--'} ms</span>
        <span>下载: {node.down || '--'}</span>
        <span>上传: {node.up || '--'}</span>
      </div>
      {isHovered && !isActive && (
        <button className="btn primary full mt" onClick={onActivate}>
          设为当前节点
        </button>
      )}
      {isActive && (
        <div className="activeBadge">✓ 当前使用中</div>
      )}
    </div>
  )
}

// 统计卡片组件
const StatCard = ({ label, value, unit, trend, color, icon }) => (
  <div className="card statCard" style={{ borderTop: `3px solid ${color}` }}>
    <div className="statHead">
      <span className="statIcon">{icon}</span>
      <span className="statLabel">{label}</span>
    </div>
    <div className="statValue">
      <b>{value}</b>
      <span>{unit}</span>
    </div>
    {trend && <MiniSparkline data={trend} color={color} />}
  </div>
)

// 健康指示器组件
const HealthItem = ({ label, value, ok }) => (
  <div className="healthItem">
    <span className="healthStatus" style={{ color: ok ? '#10b981' : '#ef4444' }}>{ok ? '✓' : '✗'}</span>
    <span className="healthLabel">{label}</span>
    <span className="healthValue">{value}</span>
  </div>
)

// 主应用
function App() {
  const [page, setPage] = useState('dash')
  const [isLoading, setIsLoading] = useState(true)
  const [toasts, setToasts] = useState([])
  const [nodes, setNodes] = useState([])
  const [activeNode, setActiveNode] = useState(null)
  const [xrayRunning, setXrayRunning] = useState(true)
  const [traffic, setTraffic] = useState({ up: 0, down: 0, conn: 0 })
  const [trafficHistory, setTrafficHistory] = useState(
    Array(20).fill(0).map(() => Math.floor(Math.random() * 100))
  )

  // Toast 辅助函数
  const showToast = useCallback((msg, type = 'info') => {
    const id = Date.now()
    setToasts(p => [...p, { id, msg, type }])
  }, [])

  const removeToast = useCallback(id => {
    setToasts(p => p.filter(t => t.id !== id))
  }, [])

  // 模拟加载
  useEffect(() => {
    const t = setTimeout(() => {
      setIsLoading(false)
      setNodes([
        { id: 1, remark: '香港-国际带宽', addr: 'hk1.example.com', port: 443, protocol: 'vmess', health: 'alive', ping: 45, down: '245 MB', up: '32 MB' },
        { id: 2, remark: '日本-东京节点', addr: 'jp1.example.com', port: 443, protocol: 'vmess', health: 'alive', ping: 78, down: '189 MB', up: '28 MB' },
        { id: 3, remark: '新加坡-AWS', addr: 'sg1.example.com', port: 2083, protocol: 'vless', health: 'dead', ping: 999, down: '0', up: '0' },
        { id: 4, remark: '美国-洛杉矶', addr: 'us1.example.com', port: 8443, protocol: 'trojan', health: 'alive', ping: 156, down: '512 MB', up: '89 MB' },
      ])
      setActiveNode(1)
    }, 800)
    return () => clearTimeout(t)
  }, [])

  // 模拟流量更新
  useEffect(() => {
    const t = setInterval(() => {
      setTraffic(p => ({
        up: p.up + Math.floor(Math.random() * 500),
        down: p.down + Math.floor(Math.random() * 2000),
        conn: 5 + Math.floor(Math.random() * 15),
      }))
      setTrafficHistory(p => {
        const n = [...p.slice(1), Math.floor(Math.random() * 100)]
        return n
      })
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // 快捷操作
  const handleStartProxy = useCallback(() => {
    setXrayRunning(true)
    showToast('代理已启动', 'success')
  }, [showToast])

  const handleStopProxy = useCallback(() => {
    setXrayRunning(false)
    showToast('代理已停止', 'info')
  }, [showToast])

  const handleRestartXray = useCallback(() => {
    showToast('正在重启 Xray...', 'info')
    setTimeout(() => {
      setXrayRunning(true)
      showToast('Xray 重启成功', 'success')
    }, 1500)
  }, [showToast])

  const handleActivateNode = useCallback(nodeId => {
    setActiveNode(nodeId)
    showToast(`已切换到节点 #${nodeId}`, 'success')
  }, [showToast])

  // 格式化字节
  const formatBytes = b => {
    if (b < 1024) return `${b} B`
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  // 页面内容
  const PageContent = useMemo(() => {
    if (isLoading) {
      return (
        <div className="page">
          <div className="section">
            <Skeleton w="280px" h="32px" />
            <br /><br />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="card" style={{ padding: '20px' }}>
                  <Skeleton w="120px" />
                  <br />
                  <Skeleton w="180px" h="36px" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )
    }

    switch (page) {
      case 'dash':
        return (
          <div className="page">
            <div className="hero">
              <div>
                <h1>Command Center</h1>
                <p>Xray 代理运行中 · v1.22.0</p>
              </div>
              <span className={`bigStatus ${xrayRunning ? 'up' : 'down'}`}>
                {xrayRunning ? '运行中' : '已停止'}
              </span>
            </div>

            <div className="section">
              <h3>快捷操作</h3>
              <div className="quickActions">
                <QuickAction icon="▶" label="启动代理" onClick={handleStartProxy} color="#10b981" variant={xrayRunning ? 'active' : 'default'} />
                <QuickAction icon="■" label="停止代理" onClick={handleStopProxy} color="#ef4444" />
                <QuickAction icon="⟳" label="重启 Xray" onClick={handleRestartXray} color="#2f6bff" />
                <QuickAction icon="↻" label="测速全部" onClick={() => showToast('正在测速所有节点...', 'info')} color="#f59e0b" />
              </div>
            </div>

            <div className="section">
              <div className="statGrid">
                <StatCard label="下载流量" value={formatBytes(traffic.down).split(' ')[0]} unit={formatBytes(traffic.down).split(' ')[1]} trend={trafficHistory} color="#2f6bff" icon="↓" />
                <StatCard label="上传流量" value={formatBytes(traffic.up).split(' ')[0]} unit={formatBytes(traffic.up).split(' ')[1]} trend={trafficHistory.map(x=>x*0.3)} color="#22c7ee" icon="↑" />
                <StatCard label="活跃连接" value={traffic.conn} unit="个" color="#7c3aed" icon="⚡" />
                <StatCard label="节点总数" value={nodes.length} unit="个" color="#10b981" icon="▢" />
              </div>
            </div>

            <div className="section">
              <h3>系统状态</h3>
              <div className="card healthCard">
                <HealthItem label="Xray 内核" value="v26.6.1" ok={xrayRunning} />
                <HealthItem label="SOCKS 代理" value=":10808" ok={xrayRunning} />
                <HealthItem label="HTTP 代理" value=":10809" ok={xrayRunning} />
                <HealthItem label="管理面板" value=":2088" ok={true} />
                <HealthItem label="TUN 模式" value="手动" ok={true} />
                <HealthItem label="当前节点" value={nodes.find(n => n.id === activeNode)?.remark || '--'} ok={activeNode !== null} />
              </div>
            </div>

            <div className="section">
              <h3>当前节点</h3>
              {nodes.filter(n => n.id === activeNode).map(node => (
                <NodeCardEnhanced key={node.id} node={node} isActive={true} />
              ))}
            </div>
          </div>
        )

      case 'nodes':
        return (
          <div className="page">
            <div className="hero">
              <div>
                <h1>节点资产中心</h1>
                <p>共 {nodes.length} 个节点 · {nodes.filter(n=>n.health==='alive').length} 个在线</p>
              </div>
              <button className="btn primary" onClick={() => showToast('导入功能开发中...', 'info')}>
                + 导入节点
              </button>
            </div>

            <div className="section">
              <div className="nodeGrid">
                {nodes.map(node => (
                  <NodeCardEnhanced 
                    key={node.id} 
                    node={node} 
                    isActive={node.id === activeNode}
                    onActivate={() => handleActivateNode(node.id)}
                    onEdit={() => showToast('编辑功能开发中...', 'info')}
                    onDelete={() => showToast('删除功能开发中...', 'info')}
                  />
                ))}
              </div>
            </div>
          </div>
        )

      // 其他页面保持简洁，核心功能已在总览和节点
      default:
        return (
          <div className="page">
            <div className="hero">
              <div>
                <h1>{pages.find(p => p.id === page)?.label || page}</h1>
                <p>v1.22.0 功能持续完善中</p>
              </div>
            </div>
            <div className="section">
              <div className="card" style={{ textAlign: 'center', padding: '60px 20px' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.3 }}>🚧</div>
                <h3>功能开发中</h3>
                <p style={{ color: '#64748b', marginTop: '8px' }}>该页面正在开发，敬请期待 v1.23.0 更新</p>
              </div>
            </div>
          </div>
        )
    }
  }, [page, isLoading, xrayRunning, traffic, trafficHistory, nodes, activeNode, handleStartProxy, handleStopProxy, handleRestartXray, handleActivateNode, showToast])

  return (
    <div className="app">
      <div className="aurora">
        <span /><span /><span />
      </div>

      <div className="appShell">
        {/* 桌面端侧边栏 */}
        <aside className="side desktop">
          <div className="brand">
            <div className="brandIcon">◉</div>
            <div>
              <b>Xray Proxy</b>
              <span>v1.22.0</span>
            </div>
            <em>PRO</em>
          </div>
          <nav>
            {pages.map(p => (
              <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)}>
                <span>{p.icon}</span>
                {p.label}
              </button>
            ))}
          </nav>
          <div className="sideCard">
            <div className="sideCardHead">系统状态</div>
            <div className="sideCardBody">
              <div className="sideStat"><b style={{ color: xrayRunning ? '#10b981' : '#ef4444' }}>{xrayRunning ? '●' : '○'}</b><span>Xray {xrayRunning ? '运行中' : '已停止'}</span></div>
              <div className="sideStat"><b>▢</b><span>{nodes.length} 节点</span></div>
              <div className="sideStat"><b>⚡</b><span>{traffic.conn} 连接</span></div>
            </div>
          </div>
        </aside>

        {/* 主内容区 */}
        <main>
          <div className="top">
            <h2>{pages.find(p => p.id === page)?.label || '总览'}</h2>
            <div className="topActions">
              <button className="btn ghost" onClick={handleRestartXray}>⟳ 刷新</button>
              <button className="btn primary" onClick={handleStartProxy}>▶ 启动</button>
            </div>
          </div>
          {PageContent}
        </main>
      </div>

      {/* 手机端底部导航 */}
      <nav className="mobileNav">
        {pages.map(p => (
          <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)}>
            {p.icon} {p.label}
          </button>
        ))}
      </nav>

      {/* Toast 容器 */}
      <div className="toastContainer">
        {toasts.map(t => (
          <Toast key={t.id} message={t.msg} type={t.type} onClose={() => removeToast(t.id)} />
        ))}
      </div>
    </div>
  )
}

// 渲染应用
const root = createRoot(document.getElementById('root'))
root.render(<App />)
