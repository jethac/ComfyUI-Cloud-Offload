# ComfyUI-Kao

Kao nodes for ComfyUI. 3D generation powered by [Kao](https://github.com/jethac/kao).

## Installation

1. Install Kao:
   ```bash
   pip install kao
   ```

2. Clone/symlink to custom_nodes:
   ```bash
   cd ComfyUI/custom_nodes
   git clone https://github.com/jethac/ComfyUI-Kao
   # or symlink for dev:
   # mklink /D ComfyUI-Kao B:\workshop\ComfyUI-Kao
   ```

3. Restart ComfyUI

## Nodes

| Node | Description |
|------|-------------|
| **Kao Load Model** | Load a Kao model (hunyuan3d-2.1-turbo, etc.) |
| **Kao Image → 3D** | Generate mesh from single image |
| **Kao Multi-View → 3D** | Generate mesh from front/left/back views |
| **Kao Image → Scene** | Reconstruct scene (depth, pointcloud) |
| **Kao Save Mesh** | Export mesh to GLB/OBJ/PLY/STL |
| **Kao Mesh Preview** | Show mesh stats |

## Example Workflow

```
[Load Image] → [Kao Load Model] → [Kao Image → 3D] → [Kao Save Mesh]
                     ↓
              "hunyuan3d-2.1-turbo"
```
