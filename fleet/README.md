# Fleet deployment

The Fleet bundle for this repo lives in `fleet/schizm`.

## Files

- `fleet.yaml`: Fleet release defaults
- `fleet/gitrepo.yml`: concrete GitRepo manifest for `smysnk/schizsm`
- `fleet/gitrepo.example.yml`: starter manifest for other repos or clusters
- `.env.fleet.example`: starter runtime secret file for production API secrets

## Local validation

```bash
yarn fleet:lint
yarn fleet:template
```

## Rollout flow

1. Push the committed changes to `main`
2. Ensure the Fleet cluster can pull `git@github.com:smysnk/schizsm.git`
3. Run the `publish` workflow or execute `yarn fleet:deploy`

The deploy helper applies `fleet/gitrepo.yml` and waits for the `web` and `api`
deployments to finish rolling out.

## Runtime Secret

`fleet.yaml` points the API deployment at the shared runtime secret
`schizm-runtime-secret`.

Create it from an env file with:

```bash
cp .env.fleet.example .env.fleet
yarn fleet:env-secret --env-file ./.env.fleet --create-namespace
```

The runtime secret is where production-only values such as `DATABASE_URL`
and `DB_SSL` should live.

## GitRepo SSH Secret

If the Fleet cluster needs the repository SSH deploy key applied manually:

```bash
yarn fleet:gitrepo-secret --create-namespace
```

## GitHub Actions kubeconfig

The `publish` workflow expects a repo secret named `FLEET_KUBECONFIG`.

Generate a least-privilege kubeconfig for the current cluster context with:

```bash
yarn fleet:kubeconfig --output /tmp/schizm-fleet.kubeconfig
gh secret set FLEET_KUBECONFIG < /tmp/schizm-fleet.kubeconfig
```

If the current kube context uses a private LAN address like `192.168.x.x`, GitHub-hosted
runners will not be able to reach it. In that case you have two supported options:

1. Run the `fleet-deploy` job on a self-hosted runner that sits on the cluster network.
   Set the repo variable `FLEET_DEPLOY_RUNNER_JSON` to a valid `runs-on` value,
   for example `["self-hosted","linux","rancher"]`.
2. Override the API server URL used in CI with a public endpoint.
   This repo defaults CI deploys to `https://kube.smysnk.com`. To use a different
   endpoint, set the repo variable `FLEET_KUBE_API_SERVER`, or regenerate the
   kubeconfig with:

```bash
yarn fleet:kubeconfig --server https://your-public-api-server.example.com --output /tmp/schizm-fleet.kubeconfig
gh secret set FLEET_KUBECONFIG < /tmp/schizm-fleet.kubeconfig
```

The generated service account can:

- create and update `GitRepo` resources in `fleet-local`
- watch Fleet bundle status in `fleet-local`
- create runtime secrets in `schizm`
- restart and watch deployments in `schizm`

## TLS

The ingress is configured for `schizm.smysnk.com` with
`cert-manager.io/cluster-issuer: letsencrypt-prod` and secret
`tls-schizm-smysnk-com`.

## Monitor And Recycle

```bash
yarn fleet:monitor
```

```bash
yarn fleet:recycle
```
