# Grayscale + Baimin

`grayscale-baimin.json` preserves the Grayscale palette and all its UI tokens except `success`, `error`, `toolDiffAdded`, and `toolDiffRemoved`, which use Baimin's green (#30A46C) and red (#E5484D). Export backgrounds are resolved to literal hex for HTML compatibility. No extensions are required.

`grayscale-baimin-light.json` is the matching 51-token light variant. Its UI and export palette is grayscale; the same four semantic tokens alone use color. Baimin's hues were darkened to green #1B6B42 and red #AD2831 so each reaches WCAG contrast 4.5:1 against every light UI surface. Text, secondary text, tool output, comments, and borders are likewise covered by quantitative UI/export tests. The terminal reference is Ghostty `911-day`, whose background was read as #f7f7f5; the theme does not modify Ghostty or Pi settings.

Sources retrieved 2026-09-09:
- Grayscale: https://github.com/codella/pi-packages/tree/main/packages/pi-theme-grayscale
- Baimin: https://github.com/aidenybai/baimin/blob/09ed0b5c5d6344cda7ed79fe224bde3e8678caba/themes/baimin.json

## Upstream licenses (MIT)

Copyright (c) 2026 Mauro Codella

Copyright (c) 2026 Aiden Bai

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
