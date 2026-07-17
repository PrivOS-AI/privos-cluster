# 🎯 Privos-Cluster - Tài Liệu Tính Năng

## 📋 Tổng Quan Hệ Thống

**Privos-Cluster** là một microservice quản lý Docker containers hoàn chỉnh với:
- **Backend**: Fastify (Node.js/TypeScript) + SQLite + Docker API
- **Frontend**: React + Vite + TanStack Query + shadcn/ui
- **Real-time**: WebSocket terminal + SSE streaming
- **Webhooks**: Event notification đến external systems

---

## 🏠 1. DASHBOARD (`/dashboard`)

### Mục đích
Cung cấp cái nhìn tổng quan về tài nguyên cluster và trạng thái hệ thống.

### Chức năng chính

#### 📊 Resource Monitoring
- **Memory Tracking**
  - Hiển thị memory available (MB/GB)
  - So sánh với total memory của host
  - Cập nhật real-time mỗi 5 giây
  
- **CPU Tracking**
  - Hiển thị CPU available (cores)
  - So sánh với total CPU cores
  - Cập nhật real-time mỗi 5 giây

#### 📦 Container Statistics
- **Container Count**: Số containers running / tổng số containers
- **Health Monitoring**: Số containers passing health checks
- **Real-time Updates**: Auto-refresh mỗi 5 giây

#### 🖼️ Image Statistics
- **Total Images**: Tổng số images được track
- **User-Built Images**: Số images tự build (source = 'built')
- **Storage Usage**: Tổng dung lượng images

#### 🔄 Cluster Status
- **Connection Status**: Hiển thị trạng thái kết nối APIs
- **System Health**: Overall cluster health indicator
- **Feature Availability**: Hiển thị các tính năng đang active

### API Endpoints
- `GET /api/v1/cluster/resources` - Lấy tài nguyên cluster
- `GET /api/v1/apps` - List tất cả containers
- `GET /api/v1/images` - List tất cả images

### Update Frequency
- **Resources**: 5 seconds
- **Containers**: 5 seconds  
- **Images**: Static load

---

## 📦 2. CONTAINERS (`/containers`)

### Mục đích
Quản lý complete lifecycle của Docker containers.

### Chức năng chính

#### 🚀 Container Deployment
**Deploy New Container Form:**
- **Image Configuration**
  - Repository path (e.g., `ghcr.io/org/app`)
  - Image tag (default: `latest`)
  - Port configuration (internal port)
  
- **Resource Allocation**
  - Memory limit (MB)
  - CPU limit (cores)
  - Temporary filesystem size (MB)
  
- **Metadata**
  - App ID (optional metadata)
  - Subdomain (auto-check availability)
  - Environment variables (JSON format)
  
- **Storage**
  - Volume attachment (optional)
  - Volume name, mount path, size

**Validation & Checks:**
- Resource availability validation
- Subdomain availability real-time check
- Docker image existence verification

#### 🎮 Container Actions
**Lifecycle Management:**
- ▶️ **Start** - Khởi động container stopped
- ⏸️ **Stop** - Dừng container running
- 🔄 **Restart** - Khởi động lại container
- 🔃 **Redeploy** - Zero-downtime rolling update
- 🗑️ **Delete** - Xóa container vĩnh viễn

**Action Features:**
- Confirmation dialogs cho destructive actions
- Real-time state updates
- Error handling với toast notifications
- Action logging

#### 📊 Monitoring & Status
**Live Status Display (5s refresh):**
- **CPU Usage**: CPU percentage utilization
- **Memory Usage**: Used/limit in MB + percentage
- **Uptime**: Container running time in seconds
- **Restart Count**: Số lần restart
- **Health Status**: healthy/unhealthy/unknown

**Container Information:**
- Docker container name & ID
- Image & tag đang chạy
- Internal URL
- Subdomain (nếu có)
- Resource allocations
- Volume attachments
- Creation/start/stop timestamps

**Status Badges:**
- Color-coded theo state & health
- Running + Healthy: Green
- Running + Unhealthy: Amber
- Stopped: Gray
- Error: Red

#### 🔧 Advanced Operations (4 Tabs)

##### 📋 Logs Tab
**Features:**
- **Real-time Logs**: Stream logs từ running containers
- **Configuration**:
  - Tail lines (default: 200)
  - Toggle timestamps
  - Auto-refresh
- **Display**: Monospace text area với syntax
- **Availability**: Chỉ khi container running

**API**: `GET /api/v1/apps/:id/logs?tail=200&timestamps=true`

##### 📁 Files Tab
**Features:**
- **File Browser**: Navigation trong container filesystem
- **Path Navigation**: 
  - Path input field (default: `/app`)
  - Directory traversal
  - Breadcrumb navigation
- **File Listing**: 
  - Name, type (file/directory/link), size
  - Modified timestamp
- **File Preview**: 
  - Read file content
  - Display trong text area
- **Availability**: Chỉ khi container running

**APIs**: 
- `GET /api/v1/apps/:id/files?path=/app`
- `GET /api/v1/apps/:id/files/content?path=/app/file.txt`

##### 💻 Terminal Tab
**Features:**
- **WebSocket Terminal**: Interactive shell access
- **Real-time I/O**: Two-way communication
- **Status Indicators**: 
  - idle → connecting → open → closed/error
- **Commands**: 
  - Shell command execution
  - Enter để send, Shift+Enter cho new line
- **Connection Management**: 
  - Auto-connect khi container running
  - Close socket button
  - Auto-disconnect khi container stopped
- **Availability**: Chỉ khi container running

**API**: `WS /api/v1/apps/:id/terminal`

##### 📤 Dispatch Tab
**Features:**
- **JSON-RPC/MCP Proxy**: Gửi payloads tới container's `/mcp` endpoint
- **Request Editor**: 
  - JSON editor với template
  - Format validation
- **Response Display**: JSON response viewer
- **Timeout**: 30 seconds
- **Use Cases**: 
  - MCP (Model Context Protocol) communication
  - Custom RPC calls
  - Service-to-service communication

**API**: `POST /api/v1/apps/:id/dispatch`

#### 📈 Container List View
**Display Features:**
- **Container Cards**: 
  - Name, state badge, adopted badge
  - Image:tag
  - Port, host port mapping
  - Volume count
  - Last update timestamp
- **Selection**: Click để select và view details
- **Status Indicators**: Running/stopped/error states
- **Filtering**: Automatic theo selected container

#### 🔍 Container Discovery & Adoption
**Adopt Existing Containers:**
- Import containers từ Docker host vào cluster
- Preserve existing configurations
- Auto-assign cluster metadata
- Track adopted containers với badge

### API Endpoints
- `POST /api/v1/apps/deploy` - Deploy container
- `POST /api/v1/apps/adopt` - Adopt existing container
- `GET /api/v1/apps` - List containers
- `GET /api/v1/apps/:id` - Get container details
- `GET /api/v1/apps/:id/status` - Live statistics
- `POST /api/v1/apps/:id/start` - Start container
- `POST /api/v1/apps/:id/stop` - Stop container
- `POST /api/v1/apps/:id/restart` - Restart container
- `POST /api/v1/apps/:id/redeploy` - Rolling update
- `DELETE /api/v1/apps/:id` - Delete container
- `GET /api/v1/apps/:id/logs` - Stream logs
- `GET /api/v1/apps/:id/files` - List files
- `GET /api/v1/apps/:id/files/content` - Read file
- `WS /api/v1/apps/:id/terminal` - WebSocket terminal
- `POST /api/v1/apps/:id/dispatch` - JSON-RPC proxy

### Background Services
- **Health Monitor**: Periodic health checks với auto-restart
- **Resource Tracker**: Real-time resource usage monitoring
- **State Reconciliation**: Sync SQLite ↔ Docker state

---

## 🖼️ 3. IMAGES (`/images`)

### Mục đích
Quản lý Docker images hoàn chỉnh với pull, register, build, và tracking.

### Chức năng chính

#### 📥 Pull Images
**Pull from Registry:**
- **Repository**: Image repository path
  - Examples: `ghcr.io/org/app`, `docker.io/nginx`, `gcr.io/project/service`
- **Tag**: Image tag (default: `latest`)
- **Description**: Optional metadata note
- **Streaming Progress**: Server-Sent Events (SSE) cho real-time progress
  - Download progress
  - Extraction steps
  - Error messages
  - Final image metadata

**Registry Support:**
- GitHub Container Registry (ghcr.io)
- Docker Hub (docker.io)
- Google Container Registry (gcr.io)
- AWS ECR
- Azure Container Registry
- Private registries

**API**: `POST /api/v1/images/pull` (SSE streaming)

#### 📋 Register Images
**Track Existing Images:**
- **Discovery**: Find images already on Docker host
- **Repository & Tag**: Image identification
- **Description**: Add metadata notes
- **Auto-Tracking**: Automatic import into database
- **Source Classification**: Marked as 'registered'

**Use Cases:**
- Images built externally
- Third-party images
- Manual docker pull commands
- Migration from existing setups

**API**: `POST /api/v1/images/register`

#### 🔨 Build Images
**Dockerfile-Based Builds:**
- **Dockerfile Editor**: 
  - Monospace text editor
  - Line numbers
  - Syntax-friendly formatting
- **Template System**: 
  - 8 pre-built templates
  - One-click apply
  - Multi-runtime support
- **Build Configuration**:
  - Image name & tag
  - Build args (JSON)
  - Description
- **Real-time Progress**: 
  - SSE streaming của build logs
  - Step-by-step progress
  - Error highlighting
  - Success notification

**Templates Available:**
- Node.js (Alpine & Debian)
- Python (Slim & Alpine)
- Go (Alpine)
- Rust (Slim)
- Java (Temurin)
- Nginx
- Static HTML

**APIs**: 
- `POST /api/v1/images/build` (SSE streaming)
- `POST /api/v1/images/build/validate` - Validate Dockerfile
- `GET /api/v1/images/build/templates` - List templates

#### 📚 Image Library
**Display & Filtering:**
- **Filter Buttons**: All / Pulled / Built / Registered
- **Search**: Search by repository or tag
- **Mine Only**: Filter by current user
- **Image Cards Display**:
  - Repository & tag
  - Source badge (pulled/built/registered)
  - Size in bytes/MB/GB
  - Digest hash
  - Label count
  - Docker ID (truncated)
  - Built by user
  - Last updated timestamp
  - Description

#### 📊 Image Statistics
**Summary Cards:**
- **Total Images**: Số images đang track
- **Total Size**: Tổng dung lượng tất cả images
- **Pulled Count**: Images từ registry
- **Registered Count**: Images imported

#### 🏷️ Image Detail Panel
**Metadata Management:**
- **Source Info**: pulled/built/registered
- **Usage Tracking**: Số containers đang dùng image
- **Digest**: Image hash
- **Size**: Disk usage
- **Description Editor**: Update description
- **Labels JSON**: Manage custom labels
- **Save Button**: Apply metadata changes

#### 🏷️ Tag Management
**Create Additional Tags:**
- **New Repository**: Target repository path
- **New Tag**: Tag name
- **Copy Operation**: Create tag từ existing image
- **Use Case**: Version management, rollback tags

**API**: `POST /api/v1/images/:id/tag`

#### 🗑️ Image Deletion
**Delete Operations:**
- **Force Delete**: Remove image regardless of usage
- **Docker Cleanup**: Remove from Docker daemon
- **Database Cleanup**: Remove tracking record
- **Confirmation Dialog**: Prevent accidental deletion

**API**: `DELETE /api/v1/images/:id?force=true`

#### 🧹 Prune Images
**Clean Dangling Images:**
- **Dangling**: Images không có any tags
- **Space Reclamation**: Free disk space
- **Safe Operation**: Chỉ xóa unused images
- **Feedback**: Success notification

**API**: `POST /api/v1/images/prune`

#### 📜 Build History
**Build Tracking:**
- **Recent Builds**: List các builds gần đây
- **Status Filter**: All / Success / Failed
- **Build Details**:
  - Build ID & timestamp
  - Image name & tag
  - Status badge
  - Duration
  - Image size
  - Error messages (nếu failed)
- **Actions**:
  - **View Logs**: Xem full build logs
  - **Rebuild**: Build lại từ Dockerfile cũ
  - **Copy Dockerfile**: Copy Dockerfile content
  - **Delete**: Xóa build record

**APIs**:
- `GET /api/v1/images/builds` - List builds
- `GET /api/v1/images/builds/:buildId` - Build details
- `DELETE /api/v1/images/builds/:buildId` - Delete record

### Image Sources
- **'pulled'**: Images từ external registries
- **'built'**: Images build từ Dockerfile trên UI
- **'registered'**: Images imported từ Docker host

### API Endpoints
- `GET /api/v1/images` - List images (filterable)
- `POST /api/v1/images/pull` - Pull từ registry (SSE)
- `POST /api/v1/images/register` - Register existing
- `POST /api/v1/images/build` - Build từ Dockerfile (SSE)
- `POST /api/v1/images/build/validate` - Validate Dockerfile
- `GET /api/v1/images/build/templates` - List templates
- `GET /api/v1/images/builds` - Build history
- `GET /api/v1/images/builds/:buildId` - Build details
- `DELETE /api/v1/images/builds/:buildId` - Delete build
- `GET /api/v1/images/:id` - Image details
- `PATCH /api/v1/images/:id` - Update metadata
- `POST /api/v1/images/:id/tag` - Create tag
- `DELETE /api/v1/images/:id` - Remove image
- `POST /api/v1/images/prune` - Clean dangling

---

## 🔍 4. DISCOVERABLE (`/discoverable`)

### Mục đích
Phát hiện và adopt containers đang chạy trên Docker host nhưng chưa được quản lý bởi cluster.

### Chức năng chính

#### 🔍 Container Discovery
**Scan Docker Host:**
- **List All Containers**: Hiển thị tất cả containers trên Docker host
- **Filter Options**:
  - **Show All Docker Containers**: Bao gồm cả non-MCP containers
  - **Include Stopped**: Hiển thị cả containers đã dừng
- **Auto-Refresh**: 10 seconds interval

#### 📋 Discoverable Container List
**Container Information Display:**
- **Identification**:
  - Docker container name
  - Docker container ID
  - Image & tag
  - Image ID (truncated)
- **Status**:
  - State (running, stopped, exited)
  - Status indicators
  - MCP label badge (nếu có)
- **Configuration**:
  - Port mappings (private → public)
  - MCP metadata (name, version, port)
  - Creation timestamp
  - Open ports count
- **Labels**: Display Docker labels

#### 🏷️ MCP Label Detection
**Automatic Label Recognition:**
- **Label Check**: `privos.mcp-app=true`
- **MCP Badge**: Hiển thị badge cho MCP-compatible containers
- **Metadata Extraction**: 
  - MCP name
  - MCP version
  - MCP port

#### ➕ Adopt Containers
**Adoption Process:**
- **One-Click Adopt**: Import container vào cluster
- **App ID Assignment**: Tự động gán App ID từ MCP metadata
- **Management Transfer**: 
  - Add to cluster tracking
  - Enable cluster controls (start/stop/restart)
  - Health monitoring activation
- **State Preservation**: Giữ nguyên container state

#### 🔄 Refresh & Sync
**Manual Refresh:**
- **Refresh Button**: Force rescan Docker host
- **Auto-Update**: 10-second polling
- **State Sync**: Sync với Docker daemon

### Adoption Benefits
- **Unified Management**: Single UI cho tất cả containers
- **Health Monitoring**: Auto health checks
- **Lifecycle Control**: Start/stop/restart operations
- **Resource Tracking**: CPU/memory monitoring
- **Logs & Terminal**: Full operational features
- **Webhook Events**: Lifecycle notifications

### API Endpoints
- `GET /api/v1/clusters/discoverable?showAll=true&includeStopped=true` - List discoverable
- `POST /api/v1/apps/adopt` - Adopt container into cluster

### Use Cases
- **Migration**: Import existing containers vào cluster
- **Unified Management**: Centralized control cho heterogeneous deployments
- **Legacy Integration**: Bring existing containers under management
- **Testing**: Test cluster features với existing containers

---

## ⚙️ 5. CAPABILITIES (`/capabilities`)

### Mục đích
Hiển thị cluster capabilities, features, và limits cho client applications.

### Chức năng chính

#### 📊 Service Information
**Cluster Identity:**
- **Service Name**: `privos-cluster`
- **Version**: Phiên bản software (e.g., `0.1.0`)
- **Protocol Version**: API protocol version (e.g., `1.0`)
- **Cluster Type**: `docker` (Docker-based orchestration)

#### ✅ Features Matrix
**Feature Availability Display:**
**Container Operations:**
- **deploy**: Create mới containers ✅
- **start**: Start stopped containers ✅
- **stop**: Stop running containers ✅
- **restart**: Restart containers ✅
- **redeploy**: Rolling updates ✅
- **delete**: Remove containers ✅
- **adopt**: Import existing containers ✅

**Operational Features:**
- **logs**: Container log streaming ✅
- **files**: File browser & viewer ✅
- **terminal**: WebSocket shell access ✅
- **stats**: Resource usage statistics ✅
- **volumes**: Volume management ✅

**Advanced Features:**
- **rolling**: Zero-downtime deployments ✅
- **secrets**: Secret management (future) ❌
- **replicas**: Multi-replica deployments (future) ❌

**Display Format:**
- Feature name với capitalize
- Yes/No indicators
- Check mark icon cho available features
- Gray text cho unavailable features

#### 📏 Limits Display
**Resource Limits:**
- **Max Containers**: 100 containers
- **Max Memory**: 8192 MB (8 GB)
- **Max CPU**: 4 CPU cores

**Usage Context:**
- Soft limits cho cluster capacity
- Used cho resource validation
- Display trong deploy forms

#### 🎯 Client Integration
**API Discovery:**
- **Dynamic Feature Detection**: Clients detect available features
- **Conditional UI**: Enable/disable features based on capabilities
- **Version Compatibility**: Protocol version matching
- **Type Recognition**: Cluster type identification

### Use Cases
- **Client Configuration**: Applications discover cluster features
- **Feature Detection**: Enable/disable UI elements dynamically
- **Capacity Planning**: Understand resource limits
- **Compatibility Checks**: Verify protocol version compatibility
- **Multi-Cluster**: Differentiate giữa cluster types (docker/k8s/swarm)

### API Endpoint
- `GET /api/v1/capabilities` - Get capabilities manifest

### Response Format
```json
{
  "service": "privos-cluster",
  "version": "0.1.0",
  "protocol": "1.0",
  "type": "docker",
  "features": {
    "deploy": true,
    "start": true,
    "stop": true,
    "restart": true,
    "redeploy": true,
    "delete": true,
    "logs": true,
    "files": true,
    "terminal": true,
    "stats": true,
    "volumes": true,
    "rolling": true,
    "secrets": false,
    "replicas": false,
    "adopt": true
  },
  "limits": {
    "maxContainers": 100,
    "maxMemoryMb": 8192,
    "maxCpus": 4
  }
}
```

---

## 🔧 6. SETTINGS (`/settings`)

### Mục đích
Quản lý cluster-level configuration, quotas, và system settings.

### Chức năng chính

#### 📊 Summary Dashboard
**Quick Stats Cards:**
- **Settings Count**: Tổng số settings đang lưu
- **Proxy Status**: Reverse proxy enabled/disabled
- **Base Domain**: Configured base domain
- **Registry Allowlist**: Số allowed registries

#### 📝 Bulk Update
**JSON Editor cho Multiple Settings:**
- **JSON Textarea**: Editor với formatting
- **Apply Button**: Patch multiple settings cùng lúc
- **Reset Draft**: Revert về current values
- **Validation**: JSON syntax validation
- **Feedback**: Success notification với updated count

**Example Payload:**
```json
{
  "reverse_proxy.enabled": true,
  "reverse_proxy.base_domain": "app.example.com"
}
```

#### ⚙️ Individual Settings Editors
**Per-Setting Management:**

##### 🌐 Reverse Proxy Settings
**`reverse_proxy.base_domain`**
- **Type**: String
- **Description**: Base domain used to compose public hosts
- **Example**: `app.example.com`
- **Usage**: Subdomain composition cho containers

**`reverse_proxy.enabled`**
- **Type**: Boolean
- **Description**: Turn public host routing on or off
- **Default**: `false`
- **Usage**: Enable/disable reverse proxy functionality

##### 💾 Resource Quotas
**`quota.max_memory_mb_total`**
- **Type**: Nullable Number
- **Description**: Optional memory ceiling for cluster
- **Default**: `null` (read from Docker host)
- **Usage**: Limit total memory allocation

**`quota.max_cpus_total`**
- **Type**: Nullable Number
- **Description**: Optional CPU ceiling for cluster
- **Default**: `null` (read from Docker host)
- **Usage**: Limit total CPU allocation

##### 🚀 Deployment Settings
**`deploy.default_resources`**
- **Type**: JSON
- **Description**: Default memory, CPU, tmp limits cho deploy forms
- **Format**: 
```json
{
  "memoryMb": 256,
  "cpus": 0.5,
  "tmpSizeMb": 64
}
```
- **Usage**: Pre-fill deploy forms với defaults

##### 🖼️ Image Settings
**`images.registry_allowlist`**
- **Type**: JSON Array
- **Description**: List of registry hostnames allowed for image pulls
- **Format**: `["ghcr.io", "docker.io", "gcr.io"]`
- **Usage**: Restrict image sources cho security

#### 🎨 Editor Features
**Input Types by Setting Type:**
- **Boolean**: Checkbox với Enabled/Disabled text
- **String**: Text input
- **Number**: Numeric input với decimal support
- **Nullable-Number**: Numeric input (blank = null)
- **JSON**: Textarea với JSON validation

**Editor Actions:**
- **Save Button**: Apply setting value
- **Validation**: Type-specific validation
- **Reset Default**: Remove setting, use default
- **Revert Draft**: Undo changes, reload current value

**Validation Feedback:**
- **Valid**: "Value looks valid" (green)
- **Invalid**: Error message (red)
- **Real-time**: Validate on input change

#### 🔄 Refresh & Sync
**Auto-Refresh**: 20 seconds interval
**Manual Refresh**: Force reload settings

#### 🏷️ Setting Metadata
**Each Setting Shows:**
- **Label**: Human-readable name
- **Key**: Setting key (e.g., `reverse_proxy.enabled`)
- **Help Text**: Description của setting purpose
- **Type Inference**: Auto-detect type nếu unknown

### API Endpoints
- `GET /api/v1/settings` - Get all settings
- `PUT /api/v1/settings/:key` - Update single setting
- `DELETE /api/v1/settings/:key` - Reset to default
- `PATCH /api/v1/settings` - Bulk update

### Default Behavior
- **Defaults Active**: If setting not in DB, use hardcoded default
- **Persistent Changes**: Saved settings override defaults
- **Reset**: Delete setting reverts to default

### Use Cases
- **Cluster Configuration**: Tune cluster behavior
- **Resource Management**: Set capacity limits
- **Security Control**: Restrict image registries
- **Networking**: Configure reverse proxy
- **Defaults Management**: Set sensible defaults cho deployments

---

## 🧠 Background Services

### Health Monitor Service
**Purpose**: Periodic health checking với auto-restart

**Features:**
- **Interval**: 5 minutes (configurable)
- **Check Method**: HTTP `/health` endpoint → Docker inspect fallback
- **Auto-Restart**: 
  - Max 3 consecutive failures
  - Max 5 restarts before error state
- **State Tracking**: healthy/unhealthy/unknown
- **Webhook Events**: Notifications cho failures, recoveries, restarts

### Webhook Sender Service
**Purpose**: Queue worker gửi lifecycle events

**Events:**
- Container created/started/stopped/deleted
- Health check failures/recoveries
- Auto-restart events
- Error states

**Destination**: External systems (privos-chat)

### State Reconciliation
**Purpose**: Sync SQLite ↔ Docker state

**Operations:**
- Periodic sync của container states
- Image tracking synchronization
- Automatic cleanup orphaned records

---

## 🔐 Authentication & Security

### JWT Authentication
**Method**: Bearer token authentication
**Endpoints Required**: All `/api/v1/*` endpoints
**Token Storage**: Browser localStorage
**Token Refresh**: Auto-refresh on expiry

### Authorization
**Current**: Single admin user
**Future**: Role-based access control (RBAC)

---

## 📡 Real-Time Features

### WebSocket Terminal
**Endpoint**: `/api/v1/apps/:id/terminal`
**Protocol**: WebSocket (WS/WSS)
**Features**:
- Interactive shell access
- Bidirectional communication
- Auto-disconnect on container stop
- Error handling & reconnection

### Server-Sent Events (SSE)
**Endpoints**:
- `/api/v1/images/pull` - Image pull progress
- `/api/v1/images/build` - Build progress streaming

**Features**:
- Real-time log streaming
- Progress updates
- Error notifications
- Completion signals

---

## 🎨 UI/UX Features

### Design System
- **Framework**: shadcn/ui components
- **Theme**: Modern, minimal design
- **Responsive**: Mobile, tablet, desktop support

### Common UI Patterns
- **Cards**: Grouped content containers
- **Badges**: Status indicators với color coding
- **Buttons**: Consistent styling (default, outline, ghost, destructive)
- **Inputs**: Labeled, validated form fields
- **Toasts**: Success/error notifications
- **Loaders**: Spinners cho async operations

### Real-Time Updates
- **Auto-Refresh**: 5-20 second polling
- **Optimistic Updates**: Immediate UI updates
- **Invalidation**: Smart cache invalidation
- **Error States**: Graceful error handling

---

## 📊 Data Management

### Database
- **Type**: SQLite
- **Location**: `data/cluster.db`
- **Tables**:
  - `containers` - Container metadata
  - `images` - Image tracking
  - `volumes` - Volume mappings
  - `settings` - Configuration
  - `image_builds` - Build history
  - `webhook_queue` - Event queue

### Docker Integration
- **Library**: dockerode
- **Socket**: `/var/run/docker.sock`
- **Network**: `mcp-apps-network`
- **Operations**: Full Docker API access

---

## 🚀 Advanced Features

### Zero-Downtime Deployment
**Method**: Rolling update strategy
**Process**:
1. Create new container với updated image
2. Wait cho health check pass
3. Stop old container
4. Route traffic to new container

### Health Checking
**Methods**:
1. HTTP `/health` endpoint
2. Docker state inspection
3. Configurable timeout (5s)
4. Configurable thresholds

### Resource Validation
**Pre-Deployment Checks**:
- Available memory verification
- CPU availability check
- Volume size validation
- Subdomain availability

---

## 📈 Monitoring & Observability

### Container Metrics
- CPU usage percentage
- Memory usage/limit
- Network I/O (future)
- Disk I/O (future)

### System Metrics
- Host total resources
- Allocated resources
- Available resources
- Container counts

### Logging
- Container logs streaming
- Build logs streaming
- Error logging
- Audit logging

---

## 🔌 Integration Points

### External Systems
- **Webhooks**: Event notifications to external systems
- **Registries**: Pull from various container registries
- **Docker Daemon**: Direct Docker API integration
- **Future**: Kubernetes API (planned)

---

## 🎯 Use Cases

### Development
- Local development container management
- Quick image building từ Dockerfile
- Log debugging với terminal access
- Easy deployment testing

### Production
- Container orchestration
- Health monitoring với auto-restart
- Resource management
- Rolling deployments

### Operations
- Unified container management
- Image lifecycle management
- System configuration
- Monitoring & alerting

---

## 📝 Notes

### Current Limitations
- Single-user system (admin only)
- No multi-tenancy yet
- No RBAC yet
- Docker-only (k8s future)

### Future Enhancements
- Kubernetes support
- Multi-cluster management
- Advanced networking
- Secret management
- Replica management
- Horizontal scaling

---

## 🔄 Update Frequency

| Page/Feature | Refresh Interval |
|--------------|------------------|
| Dashboard Resources | 5 seconds |
| Container Status | 5 seconds |
| Container List | 5 seconds |
| Images List | 10 seconds |
| Discoverable | 10 seconds |
| Settings | 20 seconds |
| Health Checks | 5 minutes (configurable) |

---

## 📞 Support

For issues or questions, refer to the project repository or documentation.

---

**Document Version**: 1.0  
**Last Updated**: 2025-01-25  
**System Version**: privos-cluster v0.1.0  
