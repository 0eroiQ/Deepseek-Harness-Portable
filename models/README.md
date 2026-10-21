# Models

Open **Settings → Models → Local models** to browse and download single-file text GGUF models matched to the current computer’s RAM. Choose **Downloaded → Use model**, then select the Local model in the chat model picker. No API key or separate model application is needed.

Verified downloads and installed metadata live under `models/local/`. Interrupted downloads resume. The reset scripts preserve this entire directory. Platform-specific llama.cpp engines live under `runtimes/` and can be reinstalled from the app.

Moving the portable folder to another computer preserves models and recalculates hardware recommendations. Existing Ollama models are not automatically imported. Cloud providers remain available separately.

## Import a manually downloaded model

Choose **Import GGUF** in Local models and select a single `.gguf` file. The app streams a copy into `models/local/`, checks the GGUF header, calculates SHA-256 and registers it under **Downloaded**. The original file is unchanged. Imports need free drive space for the copy and cannot resume after cancellation. Only import models from a source you trust; a calculated checksum does not verify the publisher or guarantee architecture compatibility. Split models and vision projectors remain unsupported.

Models above the estimated RAM budget offer **Download anyway…** and **Run anyway…**, each with an explicit confirmation. Downloading does not grant permission to run. Running a large model may fail, swap heavily or make the computer unresponsive. Run permission applies only to that model for the current app session; restarting the app requires confirmation again. RAM recommendations remain estimates.
