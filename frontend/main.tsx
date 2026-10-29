import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../app/page';
import '../app/globals.css';

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main style={{ maxWidth: 680, margin: '12vh auto', padding: 32 }}><h1>页面暂时无法显示</h1><p style={{ margin: '20px 0' }}>{this.state.error}</p><button onClick={() => window.location.reload()}>重新加载</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<AppErrorBoundary><App /></AppErrorBoundary>);
