mock_provider "aws" {}

run "node_group_has_no_taints" {
  command = plan

  variables {
    project_name = "amana"
    environment  = "test"
    region       = "us-east-1"
    vpc_id       = "vpc-12345678"
    subnet_ids   = ["subnet-12345678", "subnet-87654321"]
  }

  assert {
    condition     = length(aws_eks_node_group.this.taint) == 0
    error_message = "The EKS node group must not taint all nodes because workloads do not declare tolerations."
  }
}
