# Contributing to Gimel

Thank you for your interest in contributing!

## Development Setup
1. Create a Python 3.11+ virtual environment and install dependencies:
   ```bash
   python3 -m venv .venv
   .venv/bin/pip install -e '.[dev]'
   ```
2. Install frontend dependencies and build:
   ```bash
   (cd web && npm ci && npm run build)
   (cd agentlab/web && npm ci && npm run build)
   ```
3. Run tests before opening a pull request:
   ```bash
   .venv/bin/pytest tests/ -q
   (cd web && node nav-groups.test.mjs && node jump.test.mjs && node areas.test.mjs ../gimel/webapp/dist)
   ```

## License & Contributions
By submitting a pull request to `https://github.com/mxsp/gimel`, you confirm that you have the right to submit the contribution and agree that it may be distributed under the repository's [LICENSE](./LICENSE) as well as any commercial licenses granted by the copyright holders.
