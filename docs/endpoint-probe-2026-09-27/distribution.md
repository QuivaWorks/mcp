# Distribution endpoint probe (2026-09-27)

Unauthenticated `curl` against each route, on production (`api.quiva.ai`) and
staging (`api.microstrate.io`). GET/DELETE sent no body; POST/PATCH sent `{}`.

- **401** — the gateway has a mapping for this method and path.
- **404** — no mapping (`404 page not found` from the gateway).
- **405** — the path is mapped, but not for this method.

Controls: `GET`/`POST /accounts/zzz-nonexistent-route` return 404 on both hosts,
so `/accounts/*` is not a wildcard. `GET /accounts/distribution-message`,
`DELETE /accounts/distributions`, `PUT /accounts/distribution-product` return 405,
so mappings are per method.

Handler registrations: `accounts-service/service.go:220-290` on `origin/main` 6af2ba497.

| Method | Path | Prod | Staging | Handler |
|---|---|---|---|---|
| GET | /accounts/distributions | 401 | 401 | ListDistributionsHandler |
| GET | /accounts/distribution | 401 | 401 | GetDistributionHandler |
| PATCH | /accounts/distribution | 401 | 401 | AmendDistributionHandler |
| GET | /accounts/distribution-status | 401 | 401 | GetDistributionStatusHandler |
| POST | /accounts/distribution-invite | 401 | 401 | CreateDistributionInviteHandler |
| DELETE | /accounts/distribution-invite | 401 | 401 | RevokeDistributionInviteHandler |
| GET | /accounts/distribution-invites | 401 | 401 | ListDistributionInvitesHandler |
| POST | /accounts/send-distribution-invite | 401 | 401 | SendDistributionInviteHandler |
| POST | /accounts/resend-distribution-invite | 401 | 401 | ResendDistributionInviteHandler |
| POST | /accounts/distribution-invite-link | 401 | 401 | DistributionInviteLinkHandler |
| POST | /accounts/preview-distribution-invite | 400 | 400 | PreviewDistributionInviteHandler (public: `{"error":"The invitation link is not valid"}`) |
| POST | /accounts/redeem-distribution-invite | 401 | 401 | RedeemDistributionInviteHandler |
| GET | /accounts/distribution-invite-inbox | 401 | 401 | DistributionInviteInboxHandler |
| POST | /accounts/distribution-invite-inbox-link | 401 | 401 | DistributionInviteInboxLinkHandler |
| POST | /accounts/distribution-reprovision | 401 | 401 | ReprovisionDistributionHandler |
| POST | /accounts/distribution-message | 401 | 401 | CreateDistributionMessageHandler |
| POST | /accounts/product-definition | 401 | 401 | PublishProductDefinitionHandler |
| GET | /accounts/product-definitions | 401 | 401 | ListProductDefinitionsHandler |
| POST | /accounts/distribution-product | 401 | 401 | CreateDistributionProductHandler |
| PATCH | /accounts/distribution-product | 401 | 401 | UpdateDistributionProductHandler |
| GET | /accounts/distribution-product | 401 | 401 | GetDistributionProductHandler |
| GET | /accounts/distribution-products | 401 | 401 | ListDistributionProductsHandler |
| GET | /accounts/distribution-granted-products | 401 | 401 | GetGrantedProductsHandler |
| POST | /accounts/distribution-products-sync | 401 | 401 | SyncDistributionProductsHandler |
| POST | /accounts/distribution-lookup | 401 | 401 | DistributionLookupHandler |
| DELETE | /accounts/config-reservation | 401 | 401 | ReleaseConfigReservationHandler |
| GET | /accounts/config-reservations | 401 | 401 | ListConfigReservationsHandler |
| POST | /accounts/distribution-clear-space-cards | 404 | 404 | ClearDistributionSpaceCardsHandler (registered, unmapped) |
| POST | /accounts/config-reservations-backfill | 404 | 404 | BackfillConfigReservationsHandler (platform-only, unmapped) |
| POST | /accounts/distribution-signing-key | 401 | 401 | **none** — mapped, but no handler is registered |

## Notes

- `distribution-signing-key` is mapped on both hosts and called by the app
  (`microstrate/src/services/api/distribution/distribution.services.ts:689`),
  and two refusal messages tell callers to use it
  (`accounts-service/accounts/distributioninvite.go:455`, `distributionredeem.go:112`).
  No handler registers it, so an authenticated call reaches no responder. Do not wrap it.
- A 401 from an authenticated call is not only a bad token: every role gate
  returns `util.ErrUnauthorized`, which `util/response.go` maps to 401.
- Staging and production agree on every route.
