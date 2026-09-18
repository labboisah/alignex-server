import React from 'react';
import {createRoot} from 'react-dom/client';
import AdaptivePilotApp from './AdaptivePilotApp';
import '../renderer/styles.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><AdaptivePilotApp/></React.StrictMode>);
