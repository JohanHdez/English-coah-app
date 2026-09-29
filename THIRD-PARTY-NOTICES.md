# Third-party notices

English Coach redistributes third-party code in `vendor/`, bundled into the repository because
Manifest V3's CSP forbids loading remote scripts. Each component keeps its original license,
reproduced here as those licenses require.

---

## Transformers.js

- Author: Hugging Face
- License: **Apache License 2.0**
- Source: https://github.com/huggingface/transformers.js
- File: `vendor/transformers.js`

```
Copyright 2023 The HuggingFace Inc. team. All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

Full text: https://www.apache.org/licenses/LICENSE-2.0

This project does not modify Transformers.js: it is included exactly as distributed.

---

## ONNX Runtime Web

- Author: Microsoft Corporation
- License: **MIT**
- Source: https://github.com/microsoft/onnxruntime
- Files: `vendor/ort-wasm-simd-threaded.mjs`, `vendor/ort-wasm-simd-threaded.wasm`,
  `vendor/ort-wasm-simd-threaded.asyncify.mjs`, `vendor/ort-wasm-simd-threaded.asyncify.wasm`

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Whisper models

Not redistributed: they are downloaded from Hugging Face on first run and cached by the browser.
The `onnx-community/whisper-*.en` models derive from Whisper (OpenAI, MIT license). Check each
model's card on Hugging Face for its specific terms.

---

## When updating `vendor/`

Replace the files from the official source and **review this document**: if a license or version
changes, it has to be updated here. Redistributing third-party code without its notice breaches
both licenses, and it is the kind of failure nobody notices until someone reports it.
