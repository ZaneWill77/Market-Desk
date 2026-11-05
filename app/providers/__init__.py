"""AI providers.

Each provider module follows the interface in base.py. The public app ships one provider:
the Claude API with each user's own Anthropic API key.

Modules named local_*.py in this folder are loaded too, for private experiments on your own
machine. They're gitignored and must never be published (see CONTRIBUTING.md).
"""
import importlib
import pkgutil

from . import anthropic_api

PROVIDERS = {anthropic_api.ID: anthropic_api}

for _mod in pkgutil.iter_modules(__path__):
    if _mod.name.startswith("local_"):
        try:
            _m = importlib.import_module(f"{__name__}.{_mod.name}")
            PROVIDERS[_m.ID] = _m
        except ImportError as e:
            print(f"Skipping local provider {_mod.name}: {e}")
