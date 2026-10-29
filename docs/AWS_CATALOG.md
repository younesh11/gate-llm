# AWS model catalog

Included in version 0.3.0. Discovery and native Bedrock text inference are supported. See [Bedrock setup](BEDROCK.md) to connect the Playground.

1. Configure AWS credentials for the process running GATE. The AWS SDK uses its normal credential chain: an IAM role, environment credentials, or an optional shared AWS profile. A profile is not required. For example, after configuring and signing in to your profile, launch GATE with `AWS_PROFILE=my-profile npm start`.
2. Give that identity the read-only permissions below.
3. Sign in as a workspace owner, open **AWS models**, choose a commercial AWS region (London `eu-west-2` is the initial selection), and click **Load from AWS**.
4. Search **Models in this region** by name, provider or ID. Only active on-demand models with an ARN in the selected region and `GetFoundationModelAvailability.regionAvailability=AVAILABLE` are displayed. Provisioned-only, profile-only, unavailable and unverified models are hidden. **Cross-region / inference profiles** is a separate catalog; it does not mean those models run locally in the selected region. Copy an ID when configuring a compatible deployment in **Models & routing**.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["bedrock:ListFoundationModels", "bedrock:GetFoundationModelAvailability", "bedrock:ListInferenceProfiles"],
    "Resource": "*"
  }]
}
```

These permissions do not grant model invocation. Credentials must be available to the server, not the browser. A Bedrock provider API key saved in GATE is not used for discovery. In Docker, configure the container's runtime AWS identity; a host profile is not automatically available inside the container. Never bake credentials into an image.

## Use a local AWS profile with Docker

For a PostgreSQL installation, opt in to mounting your host's `~/.aws` directory read-only:

```sh
docker compose --env-file .env.postgres -f compose.postgres.yaml -f compose.aws-profile.yaml up -d --wait
```

The default profile is selected. Set `AWS_PROFILE` in `.env.postgres` to select another profile, and set `AWS_REGION` to your intended region (for example `us-west-2`). `GATE_AWS_CONFIG_DIR` can override the host directory. Credentials are read at runtime, never copied into the image. The container user must be able to read the files. Sign in or renew SSO sessions on the host before starting or retrying discovery; the mounted cache is read-only. Profiles that depend on a host-only `credential_process` executable need another container-compatible credential source.

Keep both `-f` arguments when recreating this installation; the regular start script does not enable this optional mount. Use this opt-in for a trusted local installation, since GATE can read the profiles in the mounted directory. For hosted deployments, prefer a workload IAM role.

## What the results mean

Foundation models show AWS model IDs, providers, input/output modalities, streaming support, inference types and lifecycle status. Regional availability is checked independently of price records; price records never create model entries. Missing availability permission or individual lookup failures hide unverified models and show a notice. Account authorization/entitlement and actual invocation are still not proven by region availability. Active inference profiles show IDs, status, type and destination count; profiles may route across regions.

Listing does not verify account invocation permissions, model access, Chat Completions compatibility, account-specific prices, context limits or remaining tokens. No model calls are made, no deployments are created, and no virtual-key usage or allowances are changed. Configure deployment input/output prices and GATE key allowances separately. For native text inference, select the AWS Bedrock provider type and a Converse-compatible model; see [Bedrock setup](BEDROCK.md).

## Input and output prices

Regional model search results include separate input and output list prices in **USD per one million tokens**, where an unambiguous regional match exists in AWS's public price files. Cross-region prices are not substituted for regional prices. These are standard on-demand text rates; batch, cached tokens, extended-context tiers, provisioned throughput, Mantle and account-specific discounts are excluded. Missing or ambiguous prices display **Price unavailable**, never an assumed zero. Inference profiles do not have inferred prices; verify their model and routing mode directly in AWS.

Prices are fetched dynamically from the unsigned public AWS Price List Bulk API for `AmazonBedrock` and `AmazonBedrockFoundationModels`. No additional IAM permission or credential is required for pricing. The server must be able to reach `pricing.us-east-1.amazonaws.com` over HTTPS. Results are cached separately per region for up to one hour; partial or failed lookups are cached for one minute. A pricing outage does not hide the model catalog. Changing region clears the displayed results until you load that region.

Each matched rate links to its AWS source. Provider and model names must match exactly, apart from a narrow Meta Llama naming normalization; conflicting prices or ambiguous model versions are refused. Public prices are informational and do not automatically overwrite deployment prices used for budget accounting. Confirm the correct model, region and pricing mode before configuring those prices.

AWS references: [Price List Bulk API files](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api-fetching-price-list-files-manually.html), [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/).

## Operational limits

Discovery uses a pinned regional HTTPS AWS endpoint. Browser-supplied endpoints, credentials and profile selection are rejected. The endpoint is owner-only and protected by the existing origin checks. It allows one active lookup and ten attempts per minute per workspace, with a 12-second deadline. Availability checks cover at most 200 eligible models with at most four checks in flight; overflow is marked incomplete. Inference profiles are paginated automatically up to 2,000 entries. Results stay in the current page and refresh only on request. Government and China partitions are not supported in this first increment.

Expired or missing credentials and denied permissions produce actionable errors without exposing raw AWS errors or credentials. Region selection does not configure the AWS account: the server's credential identity determines the account.

AWS references: [ListFoundationModels](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html), [ListInferenceProfiles](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html).
