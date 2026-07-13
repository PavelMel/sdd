---
status: approved
---

# Webhook retries — deliver failed webhooks again until they stick

## 1. Context

Partner-facing webhooks are fire-and-forget today: one failed POST and the event is lost.
Partners ask for at-least-once delivery. The platform has one backend service, a Postgres
database, and no message broker in production; a Redis instance exists for caching.

## 2. Goals

- A webhook that fails delivery is retried until it succeeds or is parked as dead-lettered.
- Operators can see and re-drive dead-lettered deliveries.

## 3. Non-goals

- Ordering guarantees across events.
- Partner-configurable retry policies (a fixed platform policy is fine).

## 4. User stories

- US-1: As a partner, I eventually receive every webhook even when my endpoint has an outage.
- US-2: As an operator, I list dead-lettered deliveries and re-drive one after the partner
  fixes their endpoint.

## 5. Acceptance criteria

- AC-01 (happy): given a delivery fails transiently, it is retried and eventually delivered
  exactly as originally signed.
- AC-02 (retry policy): given an endpoint keeps failing, retries back off and stop after the
  platform maximum, and the delivery is parked as dead-lettered.
- AC-03 (operator): given a dead-lettered delivery, an operator can re-drive it and see the
  outcome.

## 6. NFR

- A transiently failing delivery is redelivered within 15 minutes of the endpoint recovering.
- Retry state survives a service restart / deploy (no delivery lost by a rolling restart).

## 8. Open questions

(none — architecture choices such as where retry state lives are design's to make)
