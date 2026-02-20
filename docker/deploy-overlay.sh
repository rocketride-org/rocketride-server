#!/usr/bin/env bash
# =============================================================================
# Build and push the engine-new overlay image to ECR
# =============================================================================
#
# Usage:
#   ./docker/deploy-overlay.sh [TAG]
#
# Examples:
#   ./docker/deploy-overlay.sh v8          # Build and push as ecef81183-engine-new-v8
#   ./docker/deploy-overlay.sh             # Defaults to ecef81183-engine-new-latest
#
# Prerequisites:
#   - AWS CLI configured with ECR access (aws sso login --profile aparavi-dev)
#   - Docker running
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Configuration
ECR_REGISTRY="193016524212.dkr.ecr.us-east-1.amazonaws.com"
ECR_REPO="aparavi-ops/eaas"
BASE_TAG="ecef81183"
TAG_SUFFIX="${1:-latest}"
FULL_TAG="${BASE_TAG}-engine-new-${TAG_SUFFIX}"
IMAGE="${ECR_REGISTRY}/${ECR_REPO}:${FULL_TAG}"

echo "============================================"
echo "Building overlay image"
echo "  Base:  ${BASE_TAG}"
echo "  Tag:   ${FULL_TAG}"
echo "  Image: ${IMAGE}"
echo "============================================"

# Login to ECR
echo "Logging in to ECR..."
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${ECR_REGISTRY}"

# Pull base image
echo "Pulling base image..."
docker pull "${ECR_REGISTRY}/${ECR_REPO}:${BASE_TAG}" || true

# Build overlay
echo "Building overlay..."
docker build \
    -f "${SCRIPT_DIR}/Dockerfile.overlay" \
    --build-arg BASE_IMAGE="${ECR_REGISTRY}/${ECR_REPO}:${BASE_TAG}" \
    -t "${IMAGE}" \
    "${REPO_ROOT}"

# Push
echo "Pushing ${IMAGE}..."
docker push "${IMAGE}"

echo "============================================"
echo "Done! Image pushed: ${IMAGE}"
echo ""
echo "To deploy to dev:"
echo "  Update aparavi-fleet/apps/eaas/dev/deployments.yaml"
echo "  image: ${IMAGE}"
echo ""
echo "To deploy to prod:"
echo "  Update aparavi-fleet/apps/eaas/prod/deployments.yaml"
echo "  image: ${IMAGE}"
echo "============================================"
