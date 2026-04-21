# PHOBOS System Design (Test Fixture)

## Overview
PHOBOS is a local AI system with two AI models: SAYON (coordinator/front-seat) and SEREN (engine/back-seat).

## Components
- Chat interface with real-time SSE streaming
- Workspace file management and code execution
- Context-aware AI intent routing
- Copilot personas with long-term memory
- Archive knowledge base with VSS semantic search

## Technical Requirements
- Single-page React application using TypeScript
- Responsive layout with sidebar navigation
- Dark theme using Tailwind CSS
- Component-based architecture with hooks
- Status indicator showing system health