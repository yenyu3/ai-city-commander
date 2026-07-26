terraform {
  # Values are deliberately supplied through dev.tfbackend at `terraform init`.
  # A backend block cannot reference Terraform variables or resources.
  backend "s3" {}
}
