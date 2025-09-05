#!/bin/bash

echo "Starting Bytebot Application..."
echo ""

# Mandeep: Fix for super slow build
export DOCKER_BUILDKIT=1

# Parse command line arguments
PORT_BASE=""
HELP=false
USE_LOCAL=true
FORCE_REBUILD=false
CHECK_CHANGES=true

while [[ "$#" -gt 0 ]]; do
    case $1 in
        -p|--port-base)
            PORT_BASE="$2"
            shift
            ;;
        --use-remote)
            USE_LOCAL=false
            CHECK_CHANGES=false
            ;;
        --force-rebuild)
            FORCE_REBUILD=true
            ;;
        --no-check)
            CHECK_CHANGES=false
            ;;
        -h|--help)
            HELP=true
            ;;
        *)
            echo "Unknown parameter: $1"
            HELP=true
            ;;
    esac
    shift
done

if [ "$HELP" = true ]; then
    echo "Usage: ./start-bytebot.sh [options]"
    echo ""
    echo "Options:"
    echo "  -p, --port-base <number>  Set base port number (default: 9990)"
    echo "                            This will map ports as follows:"
    echo "                            - Desktop (VNC): <base>"
    echo "                            - Agent API:     <base+1>"
    echo "                            - UI:            <base+2>"
    echo "                            - PostgreSQL:    <base-5556> (e.g., 5434 for base 9990)"
    echo "  --use-remote             Use pre-built images from GitHub registry (default: use local)"
    echo "  --force-rebuild          Force rebuild of Docker images even if no changes detected"
    echo "  --no-check               Skip checking for code changes (faster startup)"
    echo "  -h, --help               Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./start-bytebot.sh                    # Use local build with auto-rebuild on changes"
    echo "  ./start-bytebot.sh -p 8000           # Use local build with ports 8000, 8001, 8002"
    echo "  ./start-bytebot.sh --use-remote      # Use pre-built images from registry"
    echo "  ./start-bytebot.sh --force-rebuild   # Force rebuild all images"
    exit 0
fi

# Set default port base if not provided
if [ -z "$PORT_BASE" ]; then
    PORT_BASE=19990
fi

# Validate port base is a number and in valid range
if ! [[ "$PORT_BASE" =~ ^[0-9]+$ ]]; then
    echo "❌ Error: Port base must be a number"
    exit 1
fi

if [ "$PORT_BASE" -lt 1024 ] || [ "$PORT_BASE" -gt 60000 ]; then
    echo "❌ Error: Port base must be between 1024 and 60000"
    exit 1
fi

# Calculate ports based on the base
DESKTOP_PORT=$PORT_BASE
AGENT_PORT=$((PORT_BASE + 1))
UI_PORT=$((PORT_BASE + 2))
POSTGRES_PORT=$((PORT_BASE - 5556))  # This gives us 5434 for default 9990

echo "📍 Using port configuration:"
echo "  - Desktop (VNC): $DESKTOP_PORT"
echo "  - Agent API:     $AGENT_PORT"
echo "  - UI:            $UI_PORT"
echo "  - PostgreSQL:    $POSTGRES_PORT"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

echo "✅ Docker is running"

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  No .env file found. Creating default .env file..."
    cat > .env << EOF
# Bytebot Environment Variables
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/bytebotdb
BYTEBOT_DESKTOP_BASE_URL=http://bytebot-desktop:9990
BYTEBOT_AGENT_BASE_URL=http://bytebot-agent:9991
BYTEBOT_DESKTOP_VNC_URL=http://bytebot-desktop:9990/websockify

# API Keys (Add your own keys here)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=

NODE_ENV=production

# Port Configuration
DESKTOP_PORT=$DESKTOP_PORT
AGENT_PORT=$AGENT_PORT
UI_PORT=$UI_PORT
POSTGRES_PORT=$POSTGRES_PORT
EOF
    echo "✅ .env file created"
else
    echo "✅ .env file found"
    # Update port configuration in existing .env
    echo ""
    echo "📝 Updating port configuration in .env..."
    
    # Remove existing port configuration if present
    grep -v "^DESKTOP_PORT=" .env | \
    grep -v "^AGENT_PORT=" .env | \
    grep -v "^UI_PORT=" .env | \
    grep -v "^POSTGRES_PORT=" .env > .env.tmp
    
    # Add new port configuration
    echo "" >> .env.tmp
    echo "# Port Configuration" >> .env.tmp
    echo "DESKTOP_PORT=$DESKTOP_PORT" >> .env.tmp
    echo "AGENT_PORT=$AGENT_PORT" >> .env.tmp
    echo "UI_PORT=$UI_PORT" >> .env.tmp
    echo "POSTGRES_PORT=$POSTGRES_PORT" >> .env.tmp
    
    mv .env.tmp .env
fi

echo ""
echo "Creating docker-compose override for custom ports..."

# Check and add ANTHROPIC_API_KEY to docker/.env if not present
if [ ! -f docker/.env ]; then
    echo "📝 Creating docker/.env file..."
    mkdir -p docker
    touch docker/.env
fi

# Check if ANTHROPIC_API_KEY exists in docker/.env
if ! grep -q "^GEMINI_API_KEY=" docker/.env 2>/dev/null; then
    echo ""
    #echo "⚠️  ANTHROPIC_API_KEY not found in docker/.env"
    #echo "📝 Adding ANTHROPIC_API_KEY to docker/.env"
    #echo "   Please update it with your actual API key: sk-ant-..."
    echo "📝 Adding GEMINI_API_KEY to docker/.env"
    echo "GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE" >> docker/.env
    echo "✅ Added ANTHROPIC_API_KEY placeholder to docker/.env"
else
    echo "✅ ANTHROPIC_API_KEY already exists in docker/.env"
fi

# Function to check if source code has changed
check_code_changes() {
    local service=$1
    local dockerfile=$2
    local image_name="bytebot-${service}"
    
    # Check if image exists
    if ! docker images | grep -q "^${image_name}"; then
        echo "Image ${image_name} not found, rebuild needed"
        return 0
    fi
    
    # Get image build time
    local image_time=$(docker inspect ${image_name} --format='{{.Created}}' 2>/dev/null | xargs date -d 2>/dev/null +%s || echo 0)
    
    # Check modification times of source files
    local latest_change=0
    
    # Check package source directory
    if [ -d "../packages/${service}" ]; then
        latest_change=$(find ../packages/${service} -type f \( -name "*.ts" -o -name "*.js" -o -name "*.json" -o -name "Dockerfile" \) -exec stat -c %Y {} \; 2>/dev/null | sort -n | tail -1 || echo 0)
    fi
    
    # Check shared directory
    if [ -d "../packages/shared" ]; then
        local shared_change=$(find ../packages/shared -type f \( -name "*.ts" -o -name "*.js" -o -name "*.json" \) -exec stat -c %Y {} \; 2>/dev/null | sort -n | tail -1 || echo 0)
        [ $shared_change -gt $latest_change ] && latest_change=$shared_change
    fi
    
    # Compare times
    if [ $latest_change -gt $image_time ]; then
        echo "Source code changed for ${service}, rebuild needed"
        return 0
    fi
    
    return 1
}

# Determine which compose file to use
COMPOSE_FILE="docker-compose.yml"
if [ "$USE_LOCAL" = true ]; then
    COMPOSE_FILE="docker-compose.local.yml"
    echo "📦 Using local build configuration"
else
    echo "🌐 Using remote pre-built images"
fi

# Navigate to docker directory
cd docker

# Create docker-compose.override.yml with custom ports
cat > docker-compose.override.yml << EOF
# This file is auto-generated by start-bytebot.sh
# It overrides the default ports in docker-compose.yml

services:
  bytebot-desktop:
    ports:
      - "$DESKTOP_PORT:9990"
  
  postgres:
    ports:
      - "$POSTGRES_PORT:5432"
  
  bytebot-agent:
    ports:
      - "$AGENT_PORT:9991"
  
  bytebot-ui:
    ports:
      - "$UI_PORT:9992"
EOF

echo "✅ Port configuration override created"
echo ""

# Check for code changes and rebuild if necessary (only for local builds)
if [ "$USE_LOCAL" = true ]; then
    NEEDS_REBUILD=false
    
    if [ "$FORCE_REBUILD" = true ]; then
        echo "🔨 Force rebuild requested"
        NEEDS_REBUILD=true
    elif [ "$CHECK_CHANGES" = true ]; then
        echo "🔍 Checking for code changes..."
        
        # Check each service for changes
        for service in bytebot-agent bytebot-ui bytebotd; do
            if check_code_changes $service; then
                NEEDS_REBUILD=true
            fi
        done
    fi
    
    if [ "$NEEDS_REBUILD" = true ]; then
        echo ""
        echo "🔨 Building Docker images locally..."
        echo "This may take several minutes..."
        docker compose -f $COMPOSE_FILE -f docker-compose.override.yml build
    else
        echo "✅ No code changes detected, using existing images"
    fi
else
    # Pull images for remote configuration
    echo "📥 Pulling Docker images..."
    docker compose -f $COMPOSE_FILE -f docker-compose.override.yml pull
fi

echo ""
echo "Stopping any existing containers..."
docker compose -f $COMPOSE_FILE -f docker-compose.override.yml down

echo ""
echo "🚀 Starting containers..."
docker compose -f $COMPOSE_FILE -f docker-compose.override.yml up -d

echo ""
echo "Checking container status..."
docker compose -f $COMPOSE_FILE -f docker-compose.override.yml ps

echo ""
echo "✅ Bytebot startup initiated!"
echo ""
echo "Services will be available at:"
echo "  - Desktop (VNC): http://localhost:$DESKTOP_PORT"
echo "  - Agent API:     http://localhost:$AGENT_PORT"
echo "  - UI:            http://localhost:$UI_PORT"
echo "  - PostgreSQL:    localhost:$POSTGRES_PORT"
echo ""
echo "Note: It may take a minute for all services to fully initialize."
echo ""
echo "To check logs: cd docker && docker compose logs -f"
echo "To stop:       cd docker && docker compose down"
echo ""
echo "To start with different ports, run:"
echo "  ./start-bytebot.sh -p <port-base>"