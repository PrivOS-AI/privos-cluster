# 🎨 UI Layout Guide - Privos Cluster

## 📍 VỊ TRÍ CÁC CHỨC NĂNG TRONG GIAO DIỆN

---

## 📦 CONTAINERS PAGE (`/containers`)

### Layout Tổng Quan
```
┌─────────────────────────────────────────────────────────────┐
│  CONTAINERS                                                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Header: "Deploy, inspect, and control Docker workloads"│ │
│  │ Stats: Running X  Stopped Y  Total Z                    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Resource Metrics (4 Cards)                             │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │ │
│  │  │ Memory   │ │   CPU    │ │  Ports   │ │ Healthy  │  │ │
│  │  │ Available│ │ Available│ │          │ │          │  │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌───────────────────────────────┬─────────────────────────┐│
│  │                               │                         ││
│  │  LEFT COLUMN (65%)             │  RIGHT COLUMN (35%)     ││
│  │                               │                         ││
│  │  ┌─────────────────────────┐   │  ┌───────────────────┐ ││
│  │  │ Managed Containers List │   │  │   Deploy App      │ ││
│  │  │ - Container 1          │   │  │   Form             │ ││
│  │  │ - Container 2          │   │  │                   │ ││
│  │  │ - Container 3          │   │  │  [Image]           │ ││
│  │  │   (click to select)    │   │  │  [Tag]             │ ││
│  │  └─────────────────────────┘   │  │  [Port]            │ ││
│  │                                 │  │  [Memory MB]      │ ││
│  │  ┌─────────────────────────┐   │  │  [CPU]            │ ││
│  │  │ Selected Container      │   │  │  [Tmp MB]         │ ││
│  │  │ Details Card            │   │  │  [App ID]         │ ││
│  │  │ (when container         │   │  │  [Subdomain]      │ ││
│  │  │  selected)              │   │  │  [Env JSON]       │ ││
│  │  │                         │   │  │  ──────────────   │ ││
│  │  │ [Info: Image, Health,   │   │  │  Optional Volume  │ ││
│  │  │  URL, Resources, etc.]  │   │  │  [Volume Name]    │ ││
│  │  │                         │   │  │  [Mount Path]     │ ││
│  │  │ [Stats: CPU, Memory,    │   │  │  [Size MB]        │ ││
│  │  │  Restarts, Files]       │   │  │                   │ ││
│  │  │                         │   │  │  [Deploy]         │ ││
│  │  │ [Action Buttons]        │   │  │     Button        │ ││
│  │  │ [Start] [Stop]          │   │  └───────────────────┘ ││
│  │  │ [Restart] [Redeploy]    │   │                         ││
│  │  │ [Delete]                │   │  ┌───────────────────┐ ││
│  │  └─────────────────────────┘   │  │ Volumes           │ ││
│  │                                 │  │ (if selected)     │ ││
│  │  ┌─────────────────────────┐   │  │ - Volume 1        │ ││
│  │  │ 🎯 OPS PANEL (4 Tabs)   │   │  │ - Volume 2        │ ││
│  │  │                         │   │  └───────────────────┘ ││
│  │  │ [Logs] [Files]          │   │                         ││
│  │  │ [Terminal] [Dispatch]   │   │                         ││
│  │  │                         │   │                         ││
│  │  │ ┌─────────────────────┐ │   │                         ││
│  │  │ │   Tab Content       │ │   │                         ││
│  │  │ │   (changes by tab)  │ │   │                         ││
│  │  │ └─────────────────────┘ │   │                         ││
│  │  └─────────────────────────┘   │                         ││
│  └───────────────────────────────┴─────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

---

## 🔥 ADVANCED OPERATIONS PANEL (4 TABS)

### Vị Trí:
- **Nằm ở**: LEFT COLUMN, dưới "Selected Container Details Card"
- **Chỉ hiển thị khi**: Có container được selected
- **Header**: "Ops" với icon Terminal
- **Description**: "Logs, files, terminal, and MCP dispatch for {container_name}"

### 📋 TAB 1: LOGS
**Vị trí**: Tab đầu tiên trong Ops Panel

**UI Components**:
```
┌─────────────────────────────────────────────────────────┐
│ Logs                                                     │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Controls:                                            │ │
│ │ [Tail: 200    ] [✓ Timestamps] [🔄 Refresh]         │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Log Viewer (Monospace Textarea)                     │ │
│ │ 2025-01-25T10:30:00.123Z [INFO] Server starting...  │ │
│ │ 2025-01-25T10:30:00.456Z [INFO] Database connected  │ │
│ │ 2025-01-25T10:30:01.789Z [INFO] Listening on :3001  │ │
│ │ ...                                                  │ │
│ │ (auto-scrolling, 280px height)                       │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Chức năng**:
- **Tail Input**: Số dòng logs hiển thị (mặc định: 200)
- **Timestamps Checkbox**: Bật/tắt timestamps
- **Refresh Button**: Reload logs
- **Log Viewer**: Textarea với monospace font, read-only

**API**: `GET /api/v1/apps/:id/logs?tail=200&timestamps=true`

**Hiển thị khi**: Container state = 'running'

---

### 📁 TAB 2: FILES
**Vị trí**: Tab thứ 2 trong Ops Panel

**UI Components**:
```
┌─────────────────────────────────────────────────────────┐
│ Files                                                    │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Controls:                                            │ │
│ │ Path: [/app          ] [🔄 Refresh]                  │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌──────────────────────────┬──────────────────────────┐ │
│ │ File Browser             │ File Preview             │ │
│ │ ┌──────────────────────┐ │ ┌──────────────────────┐ │ │
│ │ │ /app                 │ │ │ /app/package.json    │ │
│ │ ├──────────────────────┤ │ │ ├────────────────────┤ │ │
│ │ │ 📄 package.json      │ │ │ │ {                  │ │ │
│ │ │ 📄 server.js         │ │ │ │   "name": "app",   │ │ │
│ │ │ 📁 src               │ │ │ │   "version": "1.0" │ │ │
│ │ │ 📁 tests             │ │ │ │ }                  │ │ │
│ │ │ 📄 README.md         │ │ │ │                    │ │ │
│ │ └──────────────────────┘ │ └──────────────────────┘ │ │
│ │ (max-height: 300px)       │ (300px height)           │ │
│ └──────────────────────────┴──────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Chức năng**:
- **Path Input**: Nhập đường dẫn (default: `/app`)
- **File Browser**: List files/folders với icons
  - 📄 File (FileText icon)
  - 📁 Directory (FolderOpen icon)
  - 🔗 Link
- **File Preview**: Hiển thị nội dung file đã chọn
- **Click to Navigate**: Click folder để navigate, file để preview

**APIs**:
- `GET /api/v1/apps/:id/files?path=/app`
- `GET /api/v1/apps/:id/files/content?path=/app/file.txt`

**Hiển thị khi**: Container state = 'running'

---

### 💻 TAB 3: TERMINAL
**Vị trí**: Tab thứ 3 trong Ops Panel

**UI Components**:
```
┌─────────────────────────────────────────────────────────┐
│ Terminal                                                 │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Status: open                              [✕ Close] │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Terminal Output (Monospace Textarea)                │ │
│ │ [connected 10:30:00]                                │ │
│ │ $ pwd                                                │ │
│ │ /app                                                 │ │
│ │ $ ls -la                                             │ │
│ │ total 24                                             │ │
│ │ drwxr-xr-x 4 root root 4096 Jan 25 10:30 .          │ │
│ │ -rw-r--r-- 1 root root  234 Jan 25 10:30 server.js  │ │
│ │ $ _                                                  │ │
│ │ (auto-scrolling, 260px height)                       │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─────────────────────────────────┐                     │
│ │ [Type command...        ] [Send]│                     │
│ └─────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

**Chức năng**:
- **Status Indicator**: idle → connecting → open → closed/error
- **Output Viewer**: Textarea hiển thị terminal output
- **Input Field**: Nhập lệnh shell
- **Send Button**: Gửi lệnh (hoặc press Enter)
- **Close Button**: Đóng WebSocket connection

**Tương tác**:
- **Enter**: Gửi lệnh
- **Shift+Enter**: New line
- **Auto-connect**: Kết nối tự động khi tab mở
- **Auto-disconnect**: Ngắt khi container stop

**API**: `WS /api/v1/apps/:id/terminal` (WebSocket)

**Hiển thị khi**: Container state = 'running'

---

### 📤 TAB 4: DISPATCH
**Vị trí**: Tab thứ 4 trong Ops Panel

**UI Components**:
```
┌─────────────────────────────────────────────────────────┐
│ Dispatch                                                 │
│                                                          │
│ Send a JSON-RPC/MCP payload to the running app.         │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Request Editor (JSON Textarea)                      │ │
│ │ {                                                    │ │
│ │   "jsonrpc": "2.0",                                  │ │
│ │   "method": "ping",                                  │ │
│ │   "id": 1                                            │ │
│ │ }                                                    │ │
│ │ (220px height, monospace font)                       │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ [🚀 Dispatch] [⏳ Loading...]                           │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Response Viewer (JSON Textarea)                     │ │
│ │ {                                                    │ │
│ │   "jsonrpc": "2.0",                                  │ │
│ │   "result": "pong",                                  │ │
│ │   "id": 1                                            │ │
│ │ }                                                    │ │
│ │ (180px height, monospace font, read-only)           │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Chức năng**:
- **Request Editor**: JSON editor cho MCP/JSON-RPC payloads
- **Dispatch Button**: Gửi request tới container's `/mcp` endpoint
- **Response Viewer**: Hiển thị JSON response
- **Validation**: JSON syntax validation trước khi gửi
- **Timeout**: 30 seconds

**Use Cases**:
- MCP (Model Context Protocol) communication
- Custom RPC calls
- Service-to-service communication
- Testing container endpoints

**API**: `POST /api/v1/apps/:id/dispatch`

**Hiển thị khi**: Container state = 'running'

---

## 📋 CONTAINER LIST VIEW

### Vị Trí:
- **Nằm ở**: LEFT COLUMN, cùng cấp với Selected Container Details
- **Header**: "Managed Containers"

**UI Layout**:
```
┌─────────────────────────────────────────────────────────┐
│ Managed Containers                                      │
│ Click a row to inspect live status, then use the       │
│ action buttons to control it.                           │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 🐳 my-app-container                        [→]      │ │
│ │    ghcr.io/myorg/app:latest                         │ │
│ │    Port 3001  Host 8080  Volumes 1                  │ │
│ │    Updated 2 minutes ago                            │ │
│ │    [RUNNING] [adopted]                              │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ 🐳 nginx-proxy                            [→]      │ │
│ │    nginx:alpine                                     │ │
│ │    Port 80  Host 80  Volumes 0                     │ │
│ │    Updated 5 minutes ago                            │ │
│ │    [RUNNING]                                        │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ 🐳 postgres-db                             [→]      │ │
│ │    postgres:15                                      │ │
│ │    Port 5432  Host 5432  Volumes 2                 │ │
│ │    Updated 1 hour ago                              │ │
│ │    [STOPPED]                                        │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Components**:
- **Container Name**: Docker container name
- **Image**:tag: Image đang chạy
- **Badges**:
  - **State Badge**: RUNNING (green), STOPPED (gray), ERROR (red)
  - **Adopted Badge**: (sky blue) - nếu container được adopt
- **Metadata**:
  - Port: Internal port
  - Host: Host port mapping
  - Volumes: Số volumes attached
  - Updated: Last update timestamp
- **Chevron Right (→)**: Selection indicator

**Tương tác**:
- **Click để select**: Highlight container và hiển thị details
- **Selected state**: Border highlight với primary color

---

## 🔍 SELECTED CONTAINER DETAILS

### Vị Trí:
- **Nằm ở**: LEFT COLUMN, dưới Container List
- **Chỉ hiển thị khi**: Container được selected
- **Header**: Container name + ShieldAlert icon

**UI Layout**:
```
┌─────────────────────────────────────────────────────────┐
│ 🛡️ my-app-container                                     │
│ abc123def456789ghi012                                    │
│                                                          │
│ ┌─────────────────────┬─────────────────────────────────┐│
│ │ Image               │ ghcr.io/myorg/app:latest       ││
│ ├─────────────────────┼─────────────────────────────────┤│
│ │ Health              │ healthy                        ││
│ ├─────────────────────┼─────────────────────────────────┤│
│ │ Internal URL        │ http://172.17.0.5:3001         ││
│ ├─────────────────────┼─────────────────────────────────┤│
│ │ Subdomain           │ my-app.example.com             ││
│ ├─────────────────────┼─────────────────────────────────┤│
│ │ Resources           │ 256 MB, 0.5 CPU, tmp 64 MB     ││
│ ├─────────────────────┼─────────────────────────────────┤│
│ │ Uptime              │ 7200s                          ││
│ └─────────────────────┴─────────────────────────────────┘│
│                                                          │
│ ┌─────────────────────┬─────────────────────┬───────────┐│
│ │ CPU                 │ Memory              │ Restarts  ││
│ │ 2.45%               │ 128.5 / 256.0 MB    │ 0         ││
│ ├─────────────────────┴─────────────────────┴───────────┤│
│ │ Files                                               ││
│ │ 2 volume(s)                                          ││
│ └──────────────────────────────────────────────────────┘│
│                                                          │
│ [▶️ Start] [⏸️ Stop] [🔄 Restart] [🔃 Redeploy] [🗑️ Delete]│
└─────────────────────────────────────────────────────────┘
```

**Components**:

#### Info Blocks (Left Column):
- **Image**: Image:tag đang chạy
- **Health**: healthy/unhealthy/unknown
- **Internal URL**: Container's internal URL
- **Subdomain**: Public subdomain (nếu có)
- **Resources**: Memory, CPU, tmp allocation
- **Uptime**: Running time in seconds

#### Stats Pills (Right Column):
- **CPU**: CPU % usage
- **Memory**: Used/Limit in MB
- **Restart Count**: Số lần restart
- **Files**: Số volumes attached

#### Action Buttons:
- **▶️ Start**: Khởi động container (disabled nếu running)
- **⏸️ Stop**: Dừng container (disabled nếu không running)
- **🔄 Restart**: Restart container (disabled nếu không running)
- **🔃 Redeploy**: Zero-downtime rolling update
- **🗑️ Delete**: Xóa container (với confirm dialog)

---

## 🚀 DEPLOY FORM

### Vị Trí:
- **Nằm ở**: RIGHT COLUMN
- **Header**: "Deploy App"

**UI Layout**:
```
┌─────────────────────────────────────────────────────────┐
│ Deploy App                                               │
│ Launch a new managed container from a Docker image     │
│ and optionally attach a volume.                         │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Image                                                │ │
│ │ [ghcr.io/myorg/app                    ]              │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ Tag                     │ Port                       │ │
│ │ [latest           ]     │ [3001             ]        │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ Memory MB       │ CPU             │ Tmp MB          │ │
│ │ [256        ]    │ [0.5        ]    │ [64        ]   │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ App ID                                                │ │
│ │ [my-app                              ]              │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ Subdomain                                             │ │
│ │ [my-app                              ]              │ │
│ │ ┌─────────────────────────────────────────────────┐ │ │
│ │ │ ✓ Available: my-app.example.com                │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │ Environment JSON                                     │ │
│ │ ┌─────────────────────────────────────────────────┐ │ │
│ │ │ {                                                │ │ │
│ │ │   "NODE_ENV": "production"                       │ │ │
│ │ │ }                                                │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ ─────────────────────────────────────────────────────  │
│ │ Optional Volume                                      │ │
│ │ Volume name            │ Mount path                 │ │
│ │ [data            ]     │ [/app/data      ]          │ │
│ │ Volume size MB                                       │ │
│ │ [128            ]                                    │ │
│ ├─────────────────────────────────────────────────────┤ │
│ │              [🚀 Deploy Container]                   │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Components**:

#### Basic Config:
- **Image**: Repository path (e.g., ghcr.io/org/app)
- **Tag**: Image tag (default: latest)
- **Port**: Internal container port

#### Resources:
- **Memory MB**: Memory limit
- **CPU**: CPU cores (decimal allowed)
- **Tmp MB**: Temporary filesystem size

#### Metadata:
- **App ID**: Optional app identifier
- **Subdomain**: Public subdomain (với availability check)
- **Environment JSON**: Environment variables (JSON object)

#### Optional Volume:
- **Volume Name**: Tên volume
- **Mount Path**: Path trong container
- **Volume Size MB**: Dung lượng volume

#### Actions:
- **Deploy Button**: Tạo container mới
- **Validation**: Client-side validation trước khi submit

---

## 📊 RESOURCE METRICS

### Vị Trí:
- **Nằm ở**: Top của Containers page, dưới header
- **Layout**: 4 cards in a grid

**UI Layout**:
```
┌─────────────────────────────────────────────────────────┐
│ ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│ │ 💾 Memory  │  │ ⚙️ CPU     │  │ 🌐 Ports   │  │ 💚 Healthy │
│ │            │  │            │  │            │  │            │
│ │ 4.2 GB     │  │ 3.50       │  │ 3          │  │ 5          │
│ │ available  │  │ available  │  │ containers │  │ containers │
│ │            │  │            │  │ exposed    │  │ passing    │
│ │ 3.8 GB     │  │ of 4 cores │  │ on host    │  │ health     │
│ │ allocated  │  │            │  │            │  │ checks     │
│ └────────────┘  └────────────┘  └────────────┘  └────────────┘
└─────────────────────────────────────────────────────────┘
```

**Components**:
1. **Memory Available**: Available/allocated memory
2. **CPU Available**: Available/allocated CPU cores
3. **Host Ports**: Số containers exposed trên host
4. **Healthy**: Số containers passing health checks

**Update Frequency**: 5 seconds

---

## 🔍 CONTAINER DISCOVERY & ADOPTION

### Vị Trí:
- **Không nằm ở Containers page**
- **Có trang riêng**: `/discoverable`

**UI Layout**:
```
┌─────────────────────────────────────────────────────────┐
│ DISCOVERABLE                                             │
│ Containers already on the Docker host that can be       │
│ adopted into this cluster.                              │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Controls:                                            │ │
│ │ [✓ Show all Docker containers]                      │ │
│ │ [✓ Include stopped]                                 │ │
│ │                                    [🔄 Refresh]     │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Adoptable containers                                 │ │
│ │ These are containers on the Docker host that are    │ │
│ │ not yet managed by the cluster.                     │ │
│ │                                                      │ │
│ │ ┌─────────────────────────────────────────────────┐ │ │
│ │ │ 🖥️ existing-app                          [➕ Adopt]│ │ │
│ │ │    myorg/app:1.0.0 · v1.2.3                     │ │ │
│ │ │    state: running · status: healthy             │ │ │
│ │ │    Port 3001  Created 2025-01-20 10:30:00      │ │ │
│ │ │    Open ports 2  Image ID abc123def...          │ │ │
│ │ │    [MCP]                                         │ │ │
│ │ ├─────────────────────────────────────────────────┤ │ │
│ │ │ 🖥️ legacy-nginx                          [➕ Adopt]│ │ │
│ │ │    nginx:latest                                 │ │ │
│ │ │    state: running · status: healthy             │ │ │
│ │ │    Port 80  Created 2025-01-15 08:00:00        │ │ │
│ │ │    Open ports 1  Image ID def456ghi...          │ │ │
│ │ ├─────────────────────────────────────────────────┤ │ │
│ │ │ 🖥️ stopped-postgres                      [➕ Adopt]│ │ │
│ │ │    postgres:15                                  │ │ │
│ │ │    state: stopped · status: unknown             │ │ │
│ │ │    Port 5432  Created 2025-01-10 12:00:00      │ │ │
│ │ │    Open ports 1  Image ID ghi789jkl...          │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Components**:
- **Show All Checkbox**: Bao gồm cả non-MCP containers
- **Include Stopped Checkbox**: Hiển thị stopped containers
- **Refresh Button**: Force rescan Docker host
- **Container Cards**:
  - **Server Icon + Name**: Container identification
  - **MCP Badge**: (nếu có label `privos.mcp-app=true`)
  - **Image & Version**: Image tag và version
  - **State & Status**: Container state và status
  - **Metadata**: Port, created time, open ports count, image ID
  - **Adopt Button**: Import container vào cluster

**Use Cases**:
- Migration existing containers vào cluster
- Testing cluster features với existing containers
- Unified management cho heterogeneous deployments

---

## 🎯 FLOW TỔNG THỂ

### Deploy Flow:
1. **Navigate to `/containers`**
2. **Fill Deploy Form** (right column)
3. **Click "Deploy Container"**
4. **Container appears** in Managed Containers list (left column)
5. **Click container** để select
6. **View details** và **perform actions**

### Monitoring Flow:
1. **Select container** in list
2. **View live stats** in Selected Container Details
3. **Click "Ops" panel** để advanced operations
4. **Choose tab**: Logs/Files/Terminal/Dispatch
5. **Monitor/debug** container in real-time

### Adoption Flow:
1. **Navigate to `/discoverable`**
2. **Filter** containers (show all, include stopped)
3. **Find container** để adopt
4. **Click "Adopt"** button
5. **Redirected to `/containers`** với container được manage

---

## 📱 RESPONSIVE DESIGN

### Desktop (> 1280px):
- 2-column layout (65% / 35%)
- Full 4 tabs trong Ops panel
- All metrics cards in one row

### Tablet (768px - 1280px):
- Stacked layout
- 2 columns cho metrics cards
- Full tabs maintained

### Mobile (< 768px):
- Single column layout
- 1 column cho metrics cards
- Tabs wrap to multiple lines
- Simplified forms

---

## 🎨 COLOR CODING

### Status Badges:
- **Running + Healthy**: Green (`border-emerald-500/30 bg-emerald-500/10`)
- **Running + Unhealthy**: Amber (`border-amber-500/30 bg-amber-500/10`)
- **Stopped**: Gray (`border-slate-300 bg-muted`)
- **Error**: Red (`border-rose-500/30 bg-rose-500/10`)

### Selected State:
- **Primary border**: `border-primary`
- **Accent background**: `bg-accent/40`

### Adopted Badge:
- **Sky blue**: `border-sky-500/30 bg-sky-500/10 text-sky-700`

---

## 🚀 QUICK REFERENCE

| Chức Năng | Vị Trí | Tab/Section | Condition |
|-----------|--------|-------------|-----------|
| **Deploy Container** | Right column | Deploy App form | Always visible |
| **Container List** | Left column | Managed Containers | Always visible |
| **Container Details** | Left column | Below list | Container selected |
| **Start/Stop/Restart** | Left column | Details card action buttons | Container selected |
| **Redeploy** | Left column | Details card action buttons | Container selected |
| **Delete** | Left column | Details card action buttons | Container selected |
| **Logs** | Left column | Ops Panel → Logs tab | Container selected + running |
| **Files** | Left column | Ops Panel → Files tab | Container selected + running |
| **Terminal** | Left column | Ops Panel → Terminal tab | Container selected + running |
| **Dispatch** | Left column | Ops Panel → Dispatch tab | Container selected + running |
| **Discover/Aquire** | `/discoverable` page | Separate page | Navigate from sidebar |
| **Resource Metrics** | Top of page | 4 cards | Always visible |

---

**Document Version**: 1.0  
**Last Updated**: 2025-01-25  
**UI Version**: privos-cluster v0.1.0