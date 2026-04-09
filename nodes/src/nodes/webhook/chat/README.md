---
title: 'Chat'
date: 2025-05-18
---

<head>
  <title>Chat - RocketRide Documentation</title>
</head>

The Chat node is used to connect to a custom chat endpoint, allowing communication through a specified host, port, and endpoint path. This node is useful when integrating a running chat service into a pipeline.

### Configuration Steps

- Host - Enter the IP address or hostname of the server hosting the chat service.
  - Default value is `0.0.0.0`, which allows external access.
  - Use `127.0.0.1` if you only want local access.
- Port - Enter the port number that the chat service is running on.
  - Default is `5567`.
- Endpoint - Enter the endpoint route where the chat service is available.
  - Example: `/` or `/chat`.
