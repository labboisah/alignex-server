import React from 'react';
import ReactDOM from 'react-dom/client';
import { ReadinessClientApp } from './ReadinessClientApp';
import '../renderer/styles.css';

ReactDOM.createRoot(document.getElementById('readiness-root') as HTMLElement).render(
    <React.StrictMode>
        <ReadinessClientApp />
    </React.StrictMode>,
);
