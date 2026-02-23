import React from 'react';

interface SettingsPanelProps {
  onClose?: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h2>API Configuration</h2>
        {onClose && (
          <button className="close-button" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      
      <p className="settings-description">
        Configure your API keys using environment variables.
      </p>
      
      <div className="api-keys-list">
        <div className="api-key-info">
          <h3>Available Environment Variables:</h3>
          <ul>
            <li><code>GEMINI_API_KEY</code> - Google Gemini AI API key</li>
            <li><code>GLM_API_KEY</code> - GLM/Zhipu AI API key</li>
          </ul>
          <p className="info-message">
            Create a <code>.env.local</code> file in the project root to set these variables.
          </p>
        </div>
      </div>
      
      <div className="settings-footer">
        <p className="security-note">
          🔒 API keys are loaded from environment variables and are never exposed in client-side code.
        </p>
      </div>
    </div>
  );
}
