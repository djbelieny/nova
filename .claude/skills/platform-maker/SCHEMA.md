# Platform Configuration Schema

This document defines the complete YAML schema for generating a SaaS platform. The configuration file (`platform.config.yaml`) contains all settings needed to generate a fully functional platform with authentication, payments, multi-currency support, referral systems, and internationalization.

---

## Table of Contents

1. [Brand Configuration](#brand-configuration)
2. [Tier & Product Definitions](#tier--product-definitions)
3. [Agent Definitions](#agent-definitions)
4. [Currency Configuration](#currency-configuration)
5. [Country-Specific Pricing](#country-specific-pricing)
6. [Referral Program](#referral-program)
7. [Payment Provider](#payment-provider)
8. [Internationalization](#internationalization)
9. [Deployment Configuration](#deployment-configuration)
10. [Complete Example](#complete-example)
11. [Validation Rules](#validation-rules)

---

## Brand Configuration

Defines the platform's identity, domain, and visual theme.

```yaml
brand:
  # Required: Platform name displayed in UI
  name: "Zaarvy AI"

  # Required: Short brand identifier (used in URLs, code generation)
  slug: "zaarvy"

  # Required: Primary domain for the platform
  domain: "zaarvy.com"

  # Required: One-line tagline
  tagline: "Your AI Agent Command Center"

  # Optional: SEO description (defaults to tagline if omitted)
  description: "Access a curated crew of AI agents for marketing, content, and business growth."

  # Required: Color theme (hex values)
  colors:
    primary: "#8B5CF6"      # Main brand color (buttons, links)
    secondary: "#A78BFA"    # Secondary accent
    accent: "#C4B5FD"       # Highlights
    background: "#0F0F23"   # Page background
    foreground: "#FFFFFF"   # Text color
    muted: "#6B7280"        # Secondary text
    border: "#374151"       # Border color

    # Tier-specific colors (optional, will use defaults if omitted)
    tiers:
      core:
        bg: "#1E1B4B"
        text: "#A78BFA"
        border: "#4C1D95"
        gradient: "from-purple-900/20 to-transparent"
      growth:
        bg: "#0C4A6E"
        text: "#38BDF8"
        border: "#0369A1"
        gradient: "from-sky-900/20 to-transparent"
      quantum:
        bg: "#14532D"
        text: "#4ADE80"
        border: "#15803D"
        gradient: "from-green-900/20 to-transparent"

  # Optional: Asset paths (relative to /public or absolute URLs)
  assets:
    logo: "/logo.svg"
    favicon: "/favicon.ico"
    ogImage: "/og-image.png"

  # Optional: Social links
  social:
    twitter: "https://twitter.com/zaarvy"
    discord: "https://discord.gg/zaarvy"
    github: null

  # Optional: Support email
  supportEmail: "support@zaarvy.com"
```

### Brand Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name of the platform |
| `slug` | string | Yes | URL-safe identifier (lowercase, no spaces) |
| `domain` | string | Yes | Primary domain without protocol |
| `tagline` | string | Yes | Short marketing tagline |
| `description` | string | No | SEO meta description |
| `colors` | object | Yes | Color theme definition |
| `assets` | object | No | Logo and favicon paths |
| `social` | object | No | Social media links |
| `supportEmail` | string | No | Support contact email |

---

## Tier & Product Definitions

Defines the pricing tiers, what's included, and upgrade paths (order bumps).

```yaml
tiers:
  # Required: Tier progression from lowest to highest
  # First tier is always "none" (free/unauthenticated)
  hierarchy:
    - none      # Free tier (no purchase required)
    - core      # Entry-level paid tier
    - growth    # Mid-level tier
    - quantum   # Premium tier
    - secret    # Special/hidden tier (optional)

  # Required: Product definitions for each purchasable tier
  products:
    - tierKey: "core"
      # Display name (used in UI)
      name: "Core Crew"

      # Price in cents (USD base price)
      priceCents: 999

      # What's included
      agentCount: 7
      templateCount: 70
      features:
        - "7 specialized AI agents"
        - "70+ prompt templates"
        - "Lifetime access"
        - "Community support"

      # Optional: Order bump (upgrade offer shown at checkout)
      orderBump:
        enabled: true
        targetTier: "growth"        # Tier to upgrade to
        discountCents: 500          # Discount from regular upgrade price
        # Calculated: bumpPrice = (growth.price - core.price) - discountCents

      # Optional: Square product ID (auto-generated if omitted)
      squareProductId: null

      # Display order in pricing tables
      displayOrder: 1

      # Whether this tier is available for purchase
      isActive: true

    - tierKey: "growth"
      name: "Growth Guild"
      priceCents: 1999
      agentCount: 14
      templateCount: 140
      features:
        - "14 specialized AI agents"
        - "140+ prompt templates"
        - "Lifetime access"
        - "Priority support"
        - "Early access to new agents"
      orderBump:
        enabled: true
        targetTier: "quantum"
        discountCents: 1000
      displayOrder: 2
      isActive: true

    - tierKey: "quantum"
      name: "Quantum Collective"
      priceCents: 3999
      agentCount: 21
      templateCount: 210
      features:
        - "21+ specialized AI agents"
        - "210+ prompt templates"
        - "Lifetime access"
        - "VIP support"
        - "All future agents included"
        - "Exclusive quantum-tier agents"
      orderBump:
        enabled: false
      displayOrder: 3
      isActive: true

    # Optional: Secret/special tier
    - tierKey: "secret"
      name: "Secret Agent"
      priceCents: 0            # Not purchasable directly
      agentCount: 99
      templateCount: 999
      features:
        - "All agents unlocked"
        - "Exclusive secret agents"
        - "Behind-the-scenes access"
      orderBump:
        enabled: false
      displayOrder: 99
      isActive: false          # Hidden from normal UI
```

### Product Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tierKey` | string | Yes | Unique tier identifier (matches hierarchy) |
| `name` | string | Yes | Display name for the tier |
| `priceCents` | number | Yes | Base price in USD cents |
| `agentCount` | number | Yes | Number of agents included |
| `templateCount` | number | No | Number of prompt templates |
| `features` | string[] | Yes | List of feature descriptions |
| `orderBump` | object | No | Checkout upgrade offer |
| `orderBump.enabled` | boolean | Yes | Whether bump is active |
| `orderBump.targetTier` | string | Yes* | Tier to upgrade to |
| `orderBump.discountCents` | number | Yes* | Discount amount in cents |
| `squareProductId` | string | No | Square catalog ID |
| `displayOrder` | number | No | Sort order in UI (default: 0) |
| `isActive` | boolean | No | Whether tier is available (default: true) |

---

## Agent Definitions

Defines the AI agents available on the platform.

```yaml
agents:
  # Core tier agents
  - agentKey: "pixel"
    name: "Pixel"
    role: "Brand Visual Strategist"
    tierKey: "core"             # Minimum tier required

    # Agent personality and behavior
    personality: |
      Pixel is your visual virtuoso with an eye for aesthetics that never misses.
      They blend creativity with strategy, transforming abstract ideas into
      visual concepts that captivate and convert. Known for their ability to
      spot design trends before they become mainstream.

    communicationStyle: "Creative and visual-focused, uses design metaphors"
    signatureQuote: "Every pixel tells a story. Let's make yours legendary."

    # Marketing/promotional content
    idealFor:
      - "Brand identity development"
      - "Social media visual strategy"
      - "Marketing campaign visuals"
    valueProposition: "Transform your brand aesthetics with AI-powered visual strategy"
    realWorldUse: "Used by marketing teams to develop cohesive visual campaigns"

    # Optional: Links and assets
    chatgptUrl: "https://chat.openai.com/g/g-pixel"
    avatarUrl: "/agents/pixel.png"

    # Display settings
    displayOrder: 1
    isActive: true

    # Prompt templates for this agent
    prompts:
      - templateKey: "brand-audit"
        title:
          en: "Brand Visual Audit"
          pt: "Auditoria Visual da Marca"
          es: "Auditoría Visual de Marca"
        description:
          en: "Analyze and improve your brand's visual identity"
          pt: "Analise e melhore a identidade visual da sua marca"
          es: "Analiza y mejora la identidad visual de tu marca"
        prompt:
          en: |
            As a brand visual strategist, audit [BRAND_NAME]'s visual identity:
            1. Analyze current logo, colors, and typography
            2. Identify inconsistencies across touchpoints
            3. Provide actionable recommendations for improvement
          pt: |
            Como estrategista visual de marca, audite a identidade visual de [BRAND_NAME]:
            ...
          es: |
            Como estratega visual de marca, audita la identidad visual de [BRAND_NAME]:
            ...
        displayOrder: 1

      - templateKey: "social-graphics"
        title:
          en: "Social Media Graphics Guide"
          pt: "Guia de Gráficos para Redes Sociais"
          es: "Guía de Gráficos para Redes Sociales"
        # ... more prompts

  - agentKey: "orion"
    name: "Orion"
    role: "SEO & Analytics Navigator"
    tierKey: "core"
    personality: |
      Orion is the data-driven explorer who sees patterns in the digital cosmos.
      With a mind for metrics and a talent for turning numbers into narratives,
      Orion guides brands through the vast universe of SEO and analytics.
    # ... rest of agent definition

  # Growth tier agents
  - agentKey: "atlas"
    name: "Atlas"
    role: "Content Strategy Architect"
    tierKey: "growth"           # Requires Growth tier or higher
    # ... agent definition

  # Quantum tier agents
  - agentKey: "nexus"
    name: "Nexus"
    role: "AI Integration Specialist"
    tierKey: "quantum"          # Requires Quantum tier
    # ... agent definition
```

### Agent Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentKey` | string | Yes | Unique identifier for the agent |
| `name` | string | Yes | Display name |
| `role` | string | Yes | Agent's specialty/title |
| `tierKey` | string | Yes | Minimum tier required for access |
| `personality` | string | Yes | Detailed personality description |
| `communicationStyle` | string | No | How the agent communicates |
| `signatureQuote` | string | No | Memorable quote |
| `idealFor` | string[] | No | Best use cases |
| `valueProposition` | string | No | Marketing value statement |
| `realWorldUse` | string | No | Real-world application example |
| `chatgptUrl` | string | No | Link to ChatGPT GPT |
| `avatarUrl` | string | No | Path to avatar image |
| `displayOrder` | number | No | Sort order in UI |
| `isActive` | boolean | No | Whether agent is available |
| `prompts` | array | No | Prompt templates for this agent |

### Prompt Template Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `templateKey` | string | Yes | Unique template identifier |
| `title` | object | Yes | Localized titles (en, pt, es) |
| `description` | object | Yes | Localized descriptions |
| `prompt` | object | Yes | Localized prompt templates |
| `displayOrder` | number | No | Sort order |

---

## Currency Configuration

Defines supported currencies and their formatting rules.

```yaml
currencies:
  # Required: Default currency code
  default: "USD"

  # Required: List of supported currencies
  supported:
    - code: "USD"
      name: "US Dollar"
      symbol: "$"
      symbolPosition: "before"   # "before" or "after"
      decimalPlaces: 2
      thousandSeparator: ","
      decimalSeparator: "."
      isActive: true
      isDefault: true

    - code: "BRL"
      name: "Brazilian Real"
      symbol: "R$"
      symbolPosition: "before"
      decimalPlaces: 2
      thousandSeparator: "."
      decimalSeparator: ","
      isActive: true
      isDefault: false

    - code: "EUR"
      name: "Euro"
      symbol: "€"
      symbolPosition: "after"
      decimalPlaces: 2
      thousandSeparator: " "
      decimalSeparator: ","
      isActive: true
      isDefault: false

    - code: "GBP"
      name: "British Pound"
      symbol: "£"
      symbolPosition: "before"
      decimalPlaces: 2
      thousandSeparator: ","
      decimalSeparator: "."
      isActive: true
      isDefault: false
```

### Currency Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | ISO 4217 currency code |
| `name` | string | Yes | Display name |
| `symbol` | string | Yes | Currency symbol |
| `symbolPosition` | string | Yes | "before" or "after" the number |
| `decimalPlaces` | number | Yes | Number of decimal places |
| `thousandSeparator` | string | Yes | Thousand grouping character |
| `decimalSeparator` | string | Yes | Decimal point character |
| `isActive` | boolean | No | Whether currency is enabled |
| `isDefault` | boolean | No | Whether this is the default currency |

---

## Country-Specific Pricing

Defines localized pricing for different countries.

```yaml
countryPricing:
  # Pricing for Brazil
  - countryCode: "BR"
    currencyCode: "BRL"
    prices:
      core:
        priceCents: 4990          # R$49.90
        bumpPriceCents: 4990      # Order bump to growth
        bumpRegularCents: 9990    # Regular upgrade price
        bumpSavingsCents: 5000    # Savings shown to user
      growth:
        priceCents: 9990          # R$99.90
        bumpPriceCents: 9990
        bumpRegularCents: 19990
        bumpSavingsCents: 10000
      quantum:
        priceCents: 19990         # R$199.90
    isActive: true

  # Pricing for Mexico
  - countryCode: "MX"
    currencyCode: "MXN"
    prices:
      core:
        priceCents: 17900         # MXN$179
      growth:
        priceCents: 35900
      quantum:
        priceCents: 69900
    isActive: true

  # Pricing for EU countries (shared)
  - countryCode: "DE"
    currencyCode: "EUR"
    prices:
      core:
        priceCents: 899           # €8.99
      growth:
        priceCents: 1799
      quantum:
        priceCents: 3599
    isActive: true

  # Copy EU pricing to other EU countries
  - countryCode: "FR"
    currencyCode: "EUR"
    inheritsFrom: "DE"           # Uses DE pricing
    isActive: true

  - countryCode: "ES"
    currencyCode: "EUR"
    inheritsFrom: "DE"
    isActive: true
```

### Country Pricing Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `countryCode` | string | Yes | ISO 3166-1 alpha-2 country code |
| `currencyCode` | string | Yes | ISO 4217 currency code |
| `prices` | object | Yes* | Tier-specific prices |
| `prices.[tier].priceCents` | number | Yes | Base price in local currency |
| `prices.[tier].bumpPriceCents` | number | No | Order bump price |
| `prices.[tier].bumpRegularCents` | number | No | Regular upgrade price |
| `prices.[tier].bumpSavingsCents` | number | No | Savings amount |
| `inheritsFrom` | string | No | Country code to copy pricing from |
| `isActive` | boolean | No | Whether pricing is active |

---

## Referral Program

Defines the referral system, discounts, and milestone rewards.

```yaml
referral:
  # Whether referral system is enabled
  enabled: true

  # Discount given to referred users
  discount:
    type: "percentage"          # "percentage" or "fixed"
    value: 20                   # 20% off or fixed cents amount
    applicableTiers:            # Which tiers get the discount
      - "core"
      - "growth"
      - "quantum"

  # Code generation settings
  codeGeneration:
    prefix: ""                  # Optional prefix for codes
    length: 8                   # Code length (excluding prefix)
    characters: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

  # Milestone rewards (tier upgrades for referrers)
  milestones:
    - count: 5                  # Number of successful referrals
      fromTier: "core"          # User's current tier
      toTier: "growth"          # Tier they upgrade to
      description: "Upgrade to Growth Guild after 5 referrals"

    - count: 5
      fromTier: "growth"
      toTier: "quantum"
      description: "Upgrade to Quantum Collective after 5 referrals"

    - count: 10
      fromTier: "quantum"
      toTier: "secret"
      description: "Unlock Secret Agent tier after 10 referrals"

  # Tracking settings
  tracking:
    cookieDuration: 30          # Days to track referral
    attributionWindow: 7        # Days after click to attribute purchase
```

### Referral Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | No | Whether referral system is active |
| `discount.type` | string | Yes | "percentage" or "fixed" |
| `discount.value` | number | Yes | Discount amount (% or cents) |
| `discount.applicableTiers` | string[] | No | Tiers that get discount |
| `codeGeneration.prefix` | string | No | Code prefix |
| `codeGeneration.length` | number | No | Code length |
| `codeGeneration.characters` | string | No | Allowed characters |
| `milestones` | array | No | Reward definitions |
| `milestones[].count` | number | Yes | Referrals needed |
| `milestones[].fromTier` | string | Yes | Starting tier |
| `milestones[].toTier` | string | Yes | Reward tier |
| `tracking.cookieDuration` | number | No | Days to track |
| `tracking.attributionWindow` | number | No | Days for attribution |

---

## Payment Provider

Configures the payment processor (currently Square).

```yaml
payment:
  # Payment provider (currently only "square" is supported)
  provider: "square"

  square:
    # Environment: "sandbox" or "production"
    environment: "production"

    # Location ID (from Square dashboard)
    # Use env var reference: ${SQUARE_LOCATION_ID}
    locationId: "${SQUARE_LOCATION_ID}"

    # Access token (from Square developer portal)
    # Use env var reference: ${SQUARE_ACCESS_TOKEN}
    accessToken: "${SQUARE_ACCESS_TOKEN}"

    # Application ID
    applicationId: "${SQUARE_APPLICATION_ID}"

    # Webhook signature key (for verifying webhooks)
    webhookSignatureKey: "${SQUARE_WEBHOOK_SIGNATURE_KEY}"

    # Redirect URLs after payment
    redirectUrls:
      success: "/confirmation"
      cancel: "/checkout"

    # Currency for Square (always USD, conversion happens server-side)
    processingCurrency: "USD"
```

### Payment Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | Yes | Payment provider ("square") |
| `square.environment` | string | Yes | "sandbox" or "production" |
| `square.locationId` | string | Yes | Square location ID |
| `square.accessToken` | string | Yes | Square access token |
| `square.applicationId` | string | Yes | Square app ID |
| `square.webhookSignatureKey` | string | Yes | Webhook verification key |
| `square.redirectUrls.success` | string | Yes | Success redirect path |
| `square.redirectUrls.cancel` | string | Yes | Cancel redirect path |
| `square.processingCurrency` | string | No | Currency for charges |

---

## Internationalization

Configures language support and localization.

```yaml
i18n:
  # Default language code
  defaultLanguage: "en"

  # Supported languages
  supportedLanguages:
    - code: "en"
      name: "English"
      nativeName: "English"
      direction: "ltr"
      isDefault: true

    - code: "pt"
      name: "Portuguese"
      nativeName: "Português"
      direction: "ltr"
      isDefault: false

    - code: "es"
      name: "Spanish"
      nativeName: "Español"
      direction: "ltr"
      isDefault: false

  # URL structure for language switching
  urlStrategy: "path"           # "path" (/en/page), "subdomain" (en.domain.com), "query" (?lang=en)

  # Fallback behavior
  fallback:
    language: "en"              # Fallback when translation missing
    strategy: "key"             # "key" (show key), "fallback" (show fallback lang)

  # Detection settings
  detection:
    order:                      # Detection priority
      - "path"                  # Check URL path first
      - "cookie"                # Then cookie
      - "navigator"             # Then browser language
    cookieName: "i18next"
    lookupFromPathIndex: 0      # Path segment index for language
```

### i18n Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `defaultLanguage` | string | Yes | Default language code |
| `supportedLanguages` | array | Yes | Supported language definitions |
| `supportedLanguages[].code` | string | Yes | ISO 639-1 language code |
| `supportedLanguages[].name` | string | Yes | Language name in English |
| `supportedLanguages[].nativeName` | string | Yes | Language name in native |
| `supportedLanguages[].direction` | string | No | "ltr" or "rtl" |
| `urlStrategy` | string | No | URL structure for languages |
| `fallback.language` | string | No | Fallback language code |
| `fallback.strategy` | string | No | Fallback behavior |
| `detection.order` | string[] | No | Detection priority |

---

## Deployment Configuration

Configures deployment settings for different environments.

```yaml
deployment:
  # Development settings
  development:
    database:
      type: "sqlite"
      path: "./data/dev.db"
    server:
      port: 5000
      host: "localhost"
    client:
      port: 3000
      host: "localhost"

  # Production settings
  production:
    database:
      type: "postgres"
      connectionString: "${DATABASE_URL}"
      poolSize: 10
      ssl: true
    server:
      port: 5000
      host: "0.0.0.0"
    client:
      # Served from same server in production
      buildOutput: "./dist/public"

    # Docker configuration
    docker:
      enabled: true
      baseImage: "node:20-alpine"
      registry: "ghcr.io"
      imageName: "${brand.slug}"

    # SSL/TLS
    ssl:
      enabled: true
      provider: "letsencrypt"
      email: "${brand.supportEmail}"

    # Reverse proxy
    nginx:
      enabled: true
      serverName: "${brand.domain}"
      wwwRedirect: true

  # Required environment variables
  requiredEnvVars:
    - "DATABASE_URL"
    - "JWT_SECRET"
    - "SQUARE_ACCESS_TOKEN"
    - "SQUARE_APPLICATION_ID"
    - "SQUARE_LOCATION_ID"
    - "SQUARE_WEBHOOK_SIGNATURE_KEY"

  # Optional environment variables
  optionalEnvVars:
    - name: "RESEND_API_KEY"
      description: "For sending emails"
    - name: "AWS_ACCESS_KEY_ID"
      description: "For S3 storage"
    - name: "AWS_SECRET_ACCESS_KEY"
      description: "For S3 storage"
```

### Deployment Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `development.database.type` | string | No | "sqlite" (default) |
| `development.database.path` | string | No | SQLite file path |
| `development.server.port` | number | No | Server port (default: 5000) |
| `development.client.port` | number | No | Client dev port (default: 3000) |
| `production.database.type` | string | Yes | "postgres" |
| `production.database.connectionString` | string | Yes | PostgreSQL URL |
| `production.docker.enabled` | boolean | No | Generate Dockerfile |
| `production.ssl.enabled` | boolean | No | Enable SSL |
| `production.nginx.enabled` | boolean | No | Generate nginx config |
| `requiredEnvVars` | string[] | Yes | Required environment variables |

---

## Complete Example

Here's a complete example configuration file:

```yaml
# platform.config.yaml
# Complete SaaS platform configuration

brand:
  name: "Zaarvy AI"
  slug: "zaarvy"
  domain: "zaarvy.com"
  tagline: "Your AI Agent Command Center"
  description: "Access a curated crew of AI agents for marketing, content, and business growth."
  colors:
    primary: "#8B5CF6"
    secondary: "#A78BFA"
    accent: "#C4B5FD"
    background: "#0F0F23"
    foreground: "#FFFFFF"
    muted: "#6B7280"
    border: "#374151"
  assets:
    logo: "/logo.svg"
    favicon: "/favicon.ico"
  supportEmail: "support@zaarvy.com"

tiers:
  hierarchy:
    - none
    - core
    - growth
    - quantum
    - secret
  products:
    - tierKey: "core"
      name: "Core Crew"
      priceCents: 999
      agentCount: 7
      templateCount: 70
      features:
        - "7 specialized AI agents"
        - "70+ prompt templates"
        - "Lifetime access"
      orderBump:
        enabled: true
        targetTier: "growth"
        discountCents: 500
      displayOrder: 1
      isActive: true

    - tierKey: "growth"
      name: "Growth Guild"
      priceCents: 1999
      agentCount: 14
      templateCount: 140
      features:
        - "14 specialized AI agents"
        - "140+ prompt templates"
        - "Priority support"
      orderBump:
        enabled: true
        targetTier: "quantum"
        discountCents: 1000
      displayOrder: 2
      isActive: true

    - tierKey: "quantum"
      name: "Quantum Collective"
      priceCents: 3999
      agentCount: 21
      templateCount: 210
      features:
        - "21+ specialized AI agents"
        - "All future agents included"
        - "VIP support"
      orderBump:
        enabled: false
      displayOrder: 3
      isActive: true

agents:
  - agentKey: "pixel"
    name: "Pixel"
    role: "Brand Visual Strategist"
    tierKey: "core"
    personality: |
      Pixel is your visual virtuoso with an eye for aesthetics that never misses.
    signatureQuote: "Every pixel tells a story."
    idealFor:
      - "Brand identity"
      - "Visual strategy"
    displayOrder: 1
    isActive: true
    prompts:
      - templateKey: "brand-audit"
        title:
          en: "Brand Visual Audit"
          pt: "Auditoria Visual da Marca"
          es: "Auditoría Visual de Marca"
        description:
          en: "Analyze your brand's visual identity"
          pt: "Analise a identidade visual da sua marca"
          es: "Analiza la identidad visual de tu marca"
        prompt:
          en: "Audit [BRAND]'s visual identity..."
          pt: "Audite a identidade visual de [BRAND]..."
          es: "Audita la identidad visual de [BRAND]..."

currencies:
  default: "USD"
  supported:
    - code: "USD"
      name: "US Dollar"
      symbol: "$"
      symbolPosition: "before"
      decimalPlaces: 2
      thousandSeparator: ","
      decimalSeparator: "."
      isActive: true
      isDefault: true
    - code: "BRL"
      name: "Brazilian Real"
      symbol: "R$"
      symbolPosition: "before"
      decimalPlaces: 2
      thousandSeparator: "."
      decimalSeparator: ","
      isActive: true
      isDefault: false

countryPricing:
  - countryCode: "BR"
    currencyCode: "BRL"
    prices:
      core:
        priceCents: 4990
      growth:
        priceCents: 9990
      quantum:
        priceCents: 19990
    isActive: true

referral:
  enabled: true
  discount:
    type: "percentage"
    value: 20
    applicableTiers:
      - "core"
      - "growth"
      - "quantum"
  milestones:
    - count: 5
      fromTier: "core"
      toTier: "growth"
    - count: 5
      fromTier: "growth"
      toTier: "quantum"

payment:
  provider: "square"
  square:
    environment: "production"
    locationId: "${SQUARE_LOCATION_ID}"
    accessToken: "${SQUARE_ACCESS_TOKEN}"
    applicationId: "${SQUARE_APPLICATION_ID}"
    webhookSignatureKey: "${SQUARE_WEBHOOK_SIGNATURE_KEY}"
    redirectUrls:
      success: "/confirmation"
      cancel: "/checkout"

i18n:
  defaultLanguage: "en"
  supportedLanguages:
    - code: "en"
      name: "English"
      nativeName: "English"
      isDefault: true
    - code: "pt"
      name: "Portuguese"
      nativeName: "Português"
    - code: "es"
      name: "Spanish"
      nativeName: "Español"
  urlStrategy: "path"
  fallback:
    language: "en"

deployment:
  development:
    database:
      type: "sqlite"
      path: "./data/dev.db"
    server:
      port: 5000
    client:
      port: 3000
  production:
    database:
      type: "postgres"
      connectionString: "${DATABASE_URL}"
    docker:
      enabled: true
    nginx:
      enabled: true
  requiredEnvVars:
    - "DATABASE_URL"
    - "JWT_SECRET"
    - "SQUARE_ACCESS_TOKEN"
    - "SQUARE_APPLICATION_ID"
    - "SQUARE_LOCATION_ID"
    - "SQUARE_WEBHOOK_SIGNATURE_KEY"
```

---

## File Upload Requirements by Platform Type

When the platform type requires file handling, generate appropriate infrastructure.

### Ebook Platform
```yaml
files:
  uploads:
    covers:
      types: [image/jpeg, image/png, image/gif, image/webp]
      maxSize: 5MB
      destination: /public/uploads/covers
    ebooks:
      types: [application/epub+zip, application/pdf]
      maxSize: 50MB
      destination: /public/uploads/ebooks
  staticServing:
    path: /uploads
    directory: public/uploads
  components:
    - ImageUpload (with preview, drag-drop)
    - FileUpload (with progress)
    - EpubReader (using epubjs)
    - PdfViewer (using pdf.js or iframe)
```

### Course Platform
```yaml
files:
  uploads:
    videos:
      types: [video/mp4, video/webm]
      maxSize: 500MB
      destination: /uploads/videos
    thumbnails:
      types: [image/jpeg, image/png]
      maxSize: 5MB
      destination: /public/uploads/thumbnails
    attachments:
      types: [application/pdf, application/msword]
      maxSize: 25MB
      destination: /public/uploads/attachments
```

### Marketplace Platform
```yaml
files:
  uploads:
    products:
      types: [image/jpeg, image/png, image/webp]
      maxSize: 10MB
      destination: /public/uploads/products
    documents:
      types: [application/pdf]
      maxSize: 25MB
      destination: /public/uploads/documents
```

### Generated Files for File Upload

When platform type requires file uploads, generate:

1. **Server upload route** (`server/routes/upload.ts`):
```typescript
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(process.cwd(), 'public/uploads');
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/epub+zip', 'application/pdf'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type'));
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});
```

2. **Upload component** (`client/src/components/ui/image-upload.tsx`):
```typescript
// Drag-drop image upload with preview
export function ImageUpload({ onUpload, value, className }: ImageUploadProps) {
  // Implementation with preview, drag-drop, progress
}
```

3. **Server static serving** (add to `server/index.ts`):
```typescript
app.use('/uploads', express.static(path.join(process.cwd(), 'public/uploads')));
```

4. **Vite proxy** (add to `vite.config.ts`):
```typescript
proxy: {
  '/uploads': {
    target: 'http://localhost:3001',
    changeOrigin: true
  }
}
```

---

## Validation Rules

The platform generator validates the configuration before generation:

### Required Fields
- `brand.name` - Platform must have a name
- `brand.domain` - Domain is required
- `brand.slug` - URL-safe identifier required
- At least one tier in `tiers.products`
- At least one agent in `agents`
- At least one currency in `currencies.supported`
- Payment provider configuration

### Referential Integrity
- `orderBump.targetTier` must exist in `tiers.hierarchy`
- `agent.tierKey` must exist in `tiers.hierarchy`
- `countryPricing.currencyCode` must exist in `currencies.supported`
- `referral.milestones.fromTier` and `toTier` must exist in `tiers.hierarchy`

### Business Logic
- All `priceCents` values must be positive integers
- `orderBump.discountCents` must be less than the tier price difference
- Tier hierarchy must start with "none"
- Each `tierKey` must be unique
- Each `agentKey` must be unique
- Each `currencyCode` must be unique

### Environment Variables
- All `${VAR_NAME}` references must be in `deployment.requiredEnvVars` or `deployment.optionalEnvVars`
- Production deployment requires `DATABASE_URL` and `JWT_SECRET`

### Localization
- If `i18n.supportedLanguages` includes a language, all agent prompts should have translations for it
- Default language must be in `supportedLanguages`

---

## Next Steps

After creating your configuration file:

1. Run the platform generator skill with your config
2. Review generated code structure
3. Set up environment variables
4. Run database migrations
5. Start the development server
6. Test the checkout flow
7. Deploy to production

See [SKILL_PROMPT.md](./SKILL_PROMPT.md) for instructions on running the generator.
