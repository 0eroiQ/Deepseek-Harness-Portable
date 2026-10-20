# Models

Open **Settings → Models → Local models** to browse and download single-file text GGUF models matched to the current computer’s RAM. Choose **Downloaded → Use model**, then select the Local model in the chat model picker. No API key or separate model application is needed.

Verified downloads and installed metadata live under `models/local/`. Interrupted downloads resume. The reset scripts preserve this entire directory. Platform-specific llama.cpp engines live under `runtimes/` and can be reinstalled from the app.

Moving the portable folder to another computer preserves models and recalculates hardware recommendations. Existing Ollama models are not automatically imported. Cloud providers remain available separately.
