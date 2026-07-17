/**
 * Dockerfile templates service
 * Provides common Dockerfile templates for different technologies
 */

export interface DockerfileTemplate {
	id: string;
	name: string;
	description: string;
	category: string;
	dockerfile: string;
	variables: TemplateVariable[];
}

export interface TemplateVariable {
	name: string;
	description: string;
	default: string;
	required: boolean;
}

export const templates: DockerfileTemplate[] = [
	{
		id: 'nodejs',
		name: 'Node.js Application',
		description: 'Modern Node.js application with npm',
		category: 'Backend',
		dockerfile: `# Use official Node.js runtime
FROM node:{{NODE_VERSION}}-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application source
COPY . .

# Expose application port
EXPOSE {{APP_PORT}}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:{{APP_PORT}}/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["npm", "start"]`,
		variables: [
			{ name: 'NODE_VERSION', description: 'Node.js version', default: '18', required: true },
			{ name: 'APP_PORT', description: 'Application port', default: '3000', required: true },
		],
	},
	{
		id: 'python',
		name: 'Python Application',
		description: 'Python application with pip',
		category: 'Backend',
		dockerfile: `# Use official Python runtime
FROM python:{{PYTHON_VERSION}}-slim

# Set working directory
WORKDIR /app

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install system dependencies
RUN apt-get update && apt-get install -y \\
    gcc \\
    && rm -rf /var/lib/apt/lists/*

# Copy requirements file
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

# Expose application port
EXPOSE {{APP_PORT}}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:{{APP_PORT}}/health')"

# Start application
CMD ["python", "app.py"]`,
		variables: [
			{ name: 'PYTHON_VERSION', description: 'Python version', default: '3.11', required: true },
			{ name: 'APP_PORT', description: 'Application port', default: '8000', required: true },
		],
	},
	{
		id: 'nginx',
		name: 'Nginx Web Server',
		description: 'Nginx static file server',
		category: 'Web Server',
		dockerfile: `# Use official Nginx
FROM nginx:{{NGINX_VERSION}}-alpine

# Copy custom nginx config
COPY nginx.conf /etc/nginx/nginx.conf

# Copy static files
COPY ./html /usr/share/nginx/html

# Expose HTTP port
EXPOSE {{NGINX_PORT}}

# Start nginx
CMD ["nginx", "-g", "daemon off;"]`,
		variables: [
			{ name: 'NGINX_VERSION', description: 'Nginx version', default: '1.25', required: true },
			{ name: 'NGINX_PORT', description: 'Nginx port', default: '80', required: true },
		],
	},
	{
		id: 'redis',
		name: 'Redis Cache',
		description: 'Redis in-memory data store',
		category: 'Database',
		dockerfile: `# Use official Redis
FROM redis:{{REDIS_VERSION}}-alpine

# Expose Redis port
EXPOSE {{REDIS_PORT}}

# Enable persistence
VOLUME /data

# Start Redis with persistence
CMD ["redis-server", "--appendonly", "yes"]`,
		variables: [
			{ name: 'REDIS_VERSION', description: 'Redis version', default: '7', required: true },
			{ name: 'REDIS_PORT', description: 'Redis port', default: '6379', required: true },
		],
	},
	{
		id: 'postgres',
		name: 'PostgreSQL Database',
		description: 'PostgreSQL relational database',
		category: 'Database',
		dockerfile: `# Use official PostgreSQL
FROM postgres:{{POSTGRES_VERSION}}-alpine

# Set environment variables
ENV POSTGRES_USER={{POSTGRES_USER}}
ENV POSTGRES_PASSWORD={{POSTGRES_PASSWORD}}
ENV POSTGRES_DB={{POSTGRES_DB}}

# Expose PostgreSQL port
EXPOSE {{POSTGRES_PORT}}

# Volume for data persistence
VOLUME /var/lib/postgresql/data

# Start PostgreSQL
CMD ["postgres"]`,
		variables: [
			{ name: 'POSTGRES_VERSION', description: 'PostgreSQL version', default: '15', required: true },
			{ name: 'POSTGRES_USER', description: 'Default user', default: 'postgres', required: true },
			{ name: 'POSTGRES_PASSWORD', description: 'Default password', default: 'changeme', required: true },
			{ name: 'POSTGRES_DB', description: 'Default database', default: 'appdb', required: true },
			{ name: 'POSTGRES_PORT', description: 'PostgreSQL port', default: '5432', required: true },
		],
	},
	{
		id: 'golang',
		name: 'Go Application',
		description: 'Go application with multi-stage build',
		category: 'Backend',
		dockerfile: `# Build stage
FROM golang:{{GO_VERSION}}-alpine AS builder

WORKDIR /app

# Copy go mod files
COPY go.* ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build application
RUN CGO_ENABLED=0 go build -o main .

# Runtime stage
FROM alpine:{{ALPINE_VERSION}}

# Install ca-certificates for HTTPS
RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/main .

# Expose application port
EXPOSE {{APP_PORT}}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:{{APP_PORT}}/health || exit 1

# Run application
CMD ["./main"]`,
		variables: [
			{ name: 'GO_VERSION', description: 'Go version', default: '1.21', required: true },
			{ name: 'ALPINE_VERSION', description: 'Alpine version', default: '3.18', required: true },
			{ name: 'APP_PORT', description: 'Application port', default: '8080', required: true },
		],
	},
	{
		id: 'rust',
		name: 'Rust Application',
		description: 'Rust application with multi-stage build',
		category: 'Backend',
		dockerfile: `# Build stage
FROM rust:{{RUST_VERSION}}-slim AS builder

WORKDIR /app

# Copy Cargo files
COPY Cargo.toml Cargo.lock ./

# Create dummy main.rs to build dependencies
RUN mkdir src && \\
    echo "fn main() {}" > src/main.rs && \\
    cargo build --release && \\
    rm -rf src

# Copy actual source
COPY src ./src

# Build application
RUN cargo build --release

# Runtime stage
FROM debian:{{DEBIAN_VERSION}}-slim

RUN apt-get update && apt-get install -y \\
    ca-certificates \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/target/release/{{APP_NAME}} .

# Expose application port
EXPOSE {{APP_PORT}}

# Run application
CMD ["./{{APP_NAME}}"]`,
		variables: [
			{ name: 'RUST_VERSION', description: 'Rust version', default: '1.73', required: true },
			{ name: 'DEBIAN_VERSION', description: 'Debian version', default: 'bookworm', required: true },
			{ name: 'APP_NAME', description: 'Application binary name', default: 'app', required: true },
			{ name: 'APP_PORT', description: 'Application port', default: '8080', required: true },
		],
	},
	{
		id: 'java-spring',
		name: 'Java Spring Boot',
		description: 'Spring Boot application with Maven',
		category: 'Backend',
		dockerfile: `# Build stage
FROM maven:{{MAVEN_VERSION}}-jdk-{{JAVA_VERSION}} AS builder

WORKDIR /app

# Copy Maven files
COPY pom.xml .

# Download dependencies (cached layer)
RUN mvn dependency:go-offline

# Copy source code
COPY src ./src

# Build application
RUN mvn clean package -DskipTests

# Runtime stage
FROM openjdk:{{JAVA_VERSION}}-jre-slim

WORKDIR /app

# Copy JAR from builder
COPY --from=builder /app/target/{{APP_NAME}}.jar app.jar

# Expose application port
EXPOSE {{APP_PORT}}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:{{APP_PORT}}/actuator/health || exit 1

# Run application
CMD ["java", "-jar", "app.jar"]`,
		variables: [
			{ name: 'MAVEN_VERSION', description: 'Maven version', default: '3.9', required: true },
			{ name: 'JAVA_VERSION', description: 'Java version', default: '17', required: true },
			{ name: 'APP_NAME', description: 'Application name', default: 'application', required: true },
			{ name: 'APP_PORT', description: 'Application port', default: '8080', required: true },
		],
	},
	{
		id: 'docker-compose-microservice',
		name: 'Microservice Dockerfile',
		description: 'Optimized for microservice deployment',
		category: 'Microservices',
		dockerfile: `# Multi-stage build for optimized image size
FROM {{BASE_IMAGE}} AS builder

WORKDIR /build

# Copy dependency files
COPY {{DEPENDENCY_FILES}} ./

# Install dependencies
RUN {{BUILD_COMMAND}}

# Copy application source
COPY . .

# Build application
RUN {{BUILD_APP_COMMAND}}

# Production stage
FROM {{RUNTIME_IMAGE}}

# Install runtime dependencies
RUN {{RUNTIME_DEPS}}

WORKDIR /app

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Copy application from builder
COPY --from=builder --chown=appuser:appuser {{BUILD_OUTPUT}} ./app

# Switch to non-root user
USER appuser

# Expose service port
EXPOSE {{APP_PORT}}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \\
  CMD {{HEALTH_CHECK_COMMAND}}

# Start application
CMD {{START_COMMAND}}`,
		variables: [
			{ name: 'BASE_IMAGE', description: 'Base build image', default: 'node:18-alpine', required: true },
			{ name: 'RUNTIME_IMAGE', description: 'Runtime image', default: 'alpine:3.18', required: true },
			{ name: 'DEPENDENCY_FILES', description: 'Dependency files (package.json, requirements.txt, etc.)', default: 'package*.json', required: true },
			{ name: 'BUILD_COMMAND', description: 'Dependency install command', default: 'npm ci', required: true },
			{ name: 'BUILD_APP_COMMAND', description: 'Build application command', default: 'npm run build', required: true },
			{ name: 'BUILD_OUTPUT', description: 'Build output path', default: 'dist', required: true },
			{ name: 'RUNTIME_DEPS', description: 'Runtime dependencies install', default: 'true', required: false },
			{ name: 'APP_PORT', description: 'Application port', default: '3000', required: true },
			{ name: 'HEALTH_CHECK_COMMAND', description: 'Health check command', default: 'true', required: false },
			{ name: 'START_COMMAND', description: 'Start command', default: 'node server.js', required: true },
		],
	},
];

export function getTemplateById(id: string): DockerfileTemplate | undefined {
	return templates.find((t) => t.id === id);
}

export function getTemplatesByCategory(category: string): DockerfileTemplate[] {
	return templates.filter((t) => t.category === category);
}

export function getAllCategories(): string[] {
	return Array.from(new Set(templates.map((t) => t.category))).sort();
}

export function getAllTemplates(): DockerfileTemplate[] {
	return templates;
}

export function renderTemplate(template: DockerfileTemplate, variables: Record<string, string>): string {
	let dockerfile = template.dockerfile;

	for (const variable of template.variables) {
		const value = variables[variable.name] || variable.default;
		const regex = new RegExp(`{{${variable.name}}}`, 'g');
		dockerfile = dockerfile.replace(regex, value);
	}

	return dockerfile;
}
