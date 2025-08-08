import json
from flask import current_app

def get_config_value(key, default=None):
    """Gets a configuration value from the app config with dot notation support."""
    try:
        config_file = current_app.config["DB_DIR"] / 'config.json'
        with open(config_file, 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        # Support dot notation (e.g., 'session.timeout')
        keys = key.split('.')
        value = config
        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                return default
        
        return value
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return default