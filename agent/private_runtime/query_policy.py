from __future__ import annotations

import re


DEFAULT_ENABLED_QUERY_SERVICES = (
    "ec2",
    "lambda",
    "ecs",
    "vpc",
    "ebs",
    "s3",
    "rds",
    "dynamodb",
    "elasticache",
    "cloudwatch",
    "iam",
)

VALID_QUERY_SERVICES = frozenset({
    *DEFAULT_ENABLED_QUERY_SERVICES,
    "ecr",
    "eks",
    "cloudfront",
    "waf",
    "opensearch",
    "msk",
    "cloudtrail",
    "cost",
    "bedrock",
})


def normalize_enabled_query_services(value) -> tuple[str, ...]:
    if not isinstance(value, list):
        return DEFAULT_ENABLED_QUERY_SERVICES
    return tuple(dict.fromkeys(
        service for service in value
        if isinstance(service, str) and service in VALID_QUERY_SERVICES
    ))


def _service_for_table(table: str) -> str:
    if re.match(r"^aws_ec2_(application|network)_load_balancer", table):
        return "vpc"
    if table.startswith("aws_ec2_transit_gateway") or re.match(r"^aws_vpc(?:_|$)", table):
        return "vpc"
    if table.startswith("aws_ec2_"):
        return "ec2"

    prefixes = {
        "aws_lambda_": "lambda",
        "aws_ecs_": "ecs",
        "aws_ecr_": "ecr",
        "aws_eks_": "eks",
        "aws_cloudfront_": "cloudfront",
        "aws_wafv2_": "waf",
        "aws_ebs_": "ebs",
        "aws_s3_": "s3",
        "aws_rds_": "rds",
        "aws_dynamodb_": "dynamodb",
        "aws_elasticache_": "elasticache",
        "aws_opensearch_": "opensearch",
        "aws_msk_": "msk",
        "aws_cloudwatch_": "cloudwatch",
        "aws_cloudtrail_": "cloudtrail",
        "aws_cost_": "cost",
        "aws_bedrock_": "bedrock",
    }
    for prefix, service in prefixes.items():
        if table.startswith(prefix):
            return service

    if re.match(r"^aws_(iam|identitystore|ssoadmin|sts)_", table):
        return "iam"
    if table in {"aws_caller_identity", "aws_account", "aws_partition"}:
        return "iam"
    return f"unknown:{table}"


def detect_query_services(sql: str) -> tuple[str, ...]:
    tables = re.findall(r"\baws_[a-z0-9_]+\b", sql.lower())
    return tuple(dict.fromkeys(_service_for_table(table) for table in tables))


def validate_query_services(sql: str, enabled_services: tuple[str, ...]) -> None:
    enabled = set(enabled_services)
    blocked = [service for service in detect_query_services(sql) if service not in enabled]
    if blocked:
        raise ValueError(f"Query service is disabled by queryPolicy: {', '.join(blocked)}")
