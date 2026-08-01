locals {
  name = var.project_name
  azs  = slice(var.availability_zones, 0, 2)
}
