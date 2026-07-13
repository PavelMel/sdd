---
status: current
target_surfaces: [backend-service, web-frontend]
---

# SAD — in-progress

## 6. Runtime view

### Export flow

```mermaid
sequenceDiagram
    participant client
    participant service
    client->>service: request export
    service-->>client: done
```
