import unittest

from agent.private_runtime.query_policy import (
    DEFAULT_ENABLED_QUERY_SERVICES,
    detect_query_services,
    normalize_enabled_query_services,
    validate_query_services,
)


class QueryPolicyTests(unittest.TestCase):
    def test_default_policy_matches_private_service_allowlist(self):
        self.assertEqual(DEFAULT_ENABLED_QUERY_SERVICES, (
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
        ))

    def test_detects_mixed_allowed_services(self):
        services = detect_query_services(
            "select * from aws_rds_db_instance "
            "join aws_cloudwatch_metric_statistic_data_point on true "
            "join aws_vpc_security_group on true"
        )
        self.assertEqual(services, ("rds", "cloudwatch", "vpc"))

    def test_blocks_disabled_service_before_query(self):
        with self.assertRaisesRegex(ValueError, "cloudtrail"):
            validate_query_services(
                "select * from aws_cloudtrail_trail",
                DEFAULT_ENABLED_QUERY_SERVICES,
            )

    def test_normalizes_configured_services(self):
        self.assertEqual(
            normalize_enabled_query_services(["s3", "ec2", "s3", "invalid"]),
            ("s3", "ec2"),
        )


if __name__ == "__main__":
    unittest.main()
