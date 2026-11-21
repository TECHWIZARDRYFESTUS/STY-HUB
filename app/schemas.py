from pydantic import AfterValidator, BaseModel, Field
from typing import Annotated, Literal, Optional


def _validate_bcrypt_password_length(password: str) -> str:
    if len(password.encode("utf-8")) > 72:
        raise ValueError("Password must be no more than 72 UTF-8 bytes.")
    return password


BcryptPassword = Annotated[
    str,
    Field(min_length=12, max_length=256),
    AfterValidator(_validate_bcrypt_password_length),
]


class CustomerIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    phone: str = Field(min_length=5, max_length=40)
    email: Optional[str] = None
    whatsapp_opt_in: bool = False

class ServiceIn(BaseModel):
    name: str
    category: str
    unit: str = "job"
    unit_price: float = Field(ge=0)

class ServicePriceIn(BaseModel):
    unit_price: float = Field(ge=0)

class ProductIn(BaseModel):
    name: str
    sku: Optional[str] = None
    quantity: int = Field(default=0, ge=0)
    reorder_level: int = Field(default=5, ge=0)
    cost_price: float = Field(default=0, ge=0)
    selling_price: float = Field(default=0, ge=0)

class ProductPriceIn(BaseModel):
    cost_price: float = Field(ge=0)
    selling_price: float = Field(ge=0)

class MachineIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    model: str | None = Field(default=None, max_length=120)
    serial_number: str | None = Field(default=None, max_length=120)
    location: str | None = Field(default=None, max_length=160)
    status: Literal["in_service", "maintenance", "out_of_service"] = "in_service"
    notes: str | None = Field(default=None, max_length=500)

class OrderLineIn(BaseModel):
    description: str
    quantity: float = Field(gt=0)
    unit_price: float = Field(ge=0)

class OrderIn(BaseModel):
    customer_id: int
    items: list[OrderLineIn]
    notes: Optional[str] = None

class PaymentIn(BaseModel):
    amount: float = Field(gt=0)
    method: str
    reference: Optional[str] = None

class OrderProductionStatusIn(BaseModel):
    status: Literal["in_progress", "ready", "completed"]

class DocumentStatusIn(BaseModel):
    status: Literal["in_progress", "ready", "completed"]

class DocumentTextIn(BaseModel):
    text: str = Field(min_length=1, max_length=500000)

class DocumentDraftIn(BaseModel):
    customer_id: int
    title: str = Field(min_length=2, max_length=150)
    brief: str = Field(min_length=10, max_length=10000)
    requested_pages: int | None = Field(default=None, ge=1, le=500)

class DocumentAIIn(BaseModel):
    action: Literal["coach", "draft"]
    text: str = Field(default="", max_length=50000)
    instruction: str = Field(min_length=3, max_length=10000)

class TshirtQuoteIn(BaseModel):
    unit_price: float = Field(ge=0)

class TshirtProductionStatusIn(BaseModel):
    status: Literal["in_production", "ready", "completed"]

class ExpenseIn(BaseModel):
    description: str
    amount: float = Field(gt=0)
    category: str = "General"

class TshirtIn(BaseModel):
    customer_id: int
    colour: str = "White"
    size: str = "M"
    quantity: int = Field(default=1, ge=1)
    unit_price: float | None = Field(default=None, ge=0)
    notes: Optional[str] = None

class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=160)
    password: str = Field(min_length=1, max_length=256)

class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: BcryptPassword

class CustomerRegistrationIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    phone: str = Field(min_length=5, max_length=40)
    email: str = Field(min_length=3, max_length=160)
    password: BcryptPassword
    whatsapp_updates: bool = False

class StaffUserIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    email: str = Field(min_length=3, max_length=160)
    password: BcryptPassword

class AdminRecoveryIn(BaseModel):
    recovery_token: str = Field(min_length=32, max_length=256)
    current_email: str = Field(min_length=3, max_length=160)
    new_email: str | None = Field(default=None, min_length=3, max_length=160)
    new_password: BcryptPassword

class UserActiveIn(BaseModel):
    active: bool

class JobProgressUpdateIn(BaseModel):
    job_type: Literal["print", "document", "tshirt"]
    job_id: int = Field(gt=0)
    message: str = Field(min_length=3, max_length=500)

class PortalOrderLineIn(BaseModel):
    service_id: int
    quantity: float = Field(gt=0)

class PortalOrderIn(BaseModel):
    items: list[PortalOrderLineIn] = Field(min_length=1)
    notes: Optional[str] = None
