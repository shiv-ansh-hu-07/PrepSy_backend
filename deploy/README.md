# Deploying PrepSy backend on EC2

These files live on the EC2 instance and run the app + HTTPS proxy. CI/CD
(`.github/workflows/deploy.yml`) builds the image, pushes it to ECR, and tells
this box to pull + restart via SSM.

## One-time setup on the instance

Connect with SSM Session Manager, then:

```bash
# 1. Install Docker (if not already done)
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user

# 2. Create the app directory and copy these deploy files into it
mkdir -p /home/ec2-user/prepsy
cd /home/ec2-user/prepsy
# copy docker-compose.yml, Caddyfile, refresh-env.sh here

# 3. Point APP_IMAGE at your ECR image (account id + region are yours)
cat > .env <<'EOF'
APP_IMAGE=<account-id>.dkr.ecr.<region>.amazonaws.com/prepsy-backend:latest
EOF

# 4. Edit Caddyfile so the domain matches your real API subdomain

# 5. Pull secrets from SSM Parameter Store into secrets.env
chmod +x refresh-env.sh
./refresh-env.sh

# 6. Log in to ECR and start everything
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com
docker compose up -d
```

Verify: `curl -k https://<your-domain>/health` should return `{"status":"ok",...}`.

## Ongoing

- **Code changes** deploy automatically on push to `main` (GitHub Actions →
  ECR → SSM pull + restart). Nothing to do on the box.
- **Secret changes**: update the value in SSM Parameter Store, then re-run
  `./refresh-env.sh && docker compose up -d` on the box.
- **Rollback**: images are also tagged with the git SHA in ECR. Set
  `APP_IMAGE=...:<sha>` in `.env` and run `docker compose up -d`.

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Runs the app + Caddy containers |
| `Caddyfile` | HTTPS termination + reverse proxy to the app |
| `refresh-env.sh` | Writes `secrets.env` from SSM Parameter Store |
| `.env` | Static compose vars (`APP_IMAGE`) — created during setup |
| `secrets.env` | App runtime secrets — generated, never commit |
