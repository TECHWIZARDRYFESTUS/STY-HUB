import hashlib, hmac, logging, os, secrets, shutil
from io import BytesIO
from pathlib import Path
from typing import Literal
from urllib.parse import quote
from fastapi import FastAPI, Depends, HTTPException, Request, Response, UploadFile, File, Form
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from sqlalchemy import func, inspect, text
from sqlalchemy.exc import IntegrityError
from docx import Document as WordDocument
from docx.shared import Pt
from .database import Base, engine, get_db
from . import models, schemas
from .services import (
    AIProviderError,
    AIUnavailableError,
    ai_assist,
    ai_edit,
    ai_is_configured,
    discount_rate,
    extract_text,
    money,
)
from .auth import create_session_token, hash_password, password_fingerprint, read_session_token, verify_password
from .config import (
    BUSINESS_NAME,
    CURRENCY,
    DATABASE_URL,
    INITIAL_ADMIN_EMAIL,
    INITIAL_ADMIN_PASSWORD,
    OPENAI_MODEL,
    UPLOAD_DIR,
    SESSION_COOKIE_SECURE,
    SESSION_SECRET,
    SESSION_TTL_SECONDS,
    ADMIN_RESET_TOKEN,
)
from .notifications import send_job_completed_whatsapp

Base.metadata.create_all(bind=engine)
order_columns = {column["name"] for column in inspect(engine).get_columns("orders")}
customer_columns = {column["name"] for column in inspect(engine).get_columns("customers")}
with engine.begin() as connection:
    if "production_status" not in order_columns:
        connection.execute(text(
            "ALTER TABLE orders ADD COLUMN production_status "
            "VARCHAR(40) NOT NULL DEFAULT 'received'"
        ))
    if "attachment_path" not in order_columns:
        connection.execute(text(
            "ALTER TABLE orders ADD COLUMN attachment_path VARCHAR(500)"
        ))
    if "whatsapp_opt_in" not in customer_columns:
        connection.execute(text(
            "ALTER TABLE customers ADD COLUMN whatsapp_opt_in "
            "BOOLEAN NOT NULL DEFAULT 0"
        ))
os.makedirs(UPLOAD_DIR, exist_ok=True)
if not SESSION_SECRET:
    SESSION_SECRET = secrets.token_urlsafe(48)
    logging.getLogger("printbiz").warning("SESSION_SECRET is unset; active sessions will expire when the app restarts.")
app = FastAPI(title=BUSINESS_NAME, version="1.0.0", description="Stationery, printing and AI document business platform")
app.mount("/static", StaticFiles(directory="app/static"), name="static")

def user_payload(user: models.User) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "role": user.role,
        "customer_id": user.customer_id,
    }

def machine_payload(machine: models.Machine) -> dict:
    return {
        "id": machine.id,
        "name": machine.name,
        "model": machine.model,
        "serial_number": machine.serial_number,
        "location": machine.location,
        "status": machine.status,
        "notes": machine.notes,
        "created_at": machine.created_at,
    }

def get_current_user(request: Request, db: Session=Depends(get_db)) -> models.User:
    token = request.cookies.get("printbiz_session")
    session = read_session_token(token, SESSION_SECRET) if token else None
    user = db.get(models.User, session[0]) if session else None
    if not user or not user.active or session[1] != password_fingerprint(user.password_hash):
        raise HTTPException(401, "Please sign in to continue.")
    return user

def require_roles(*roles: str):
    def role_dependency(user: models.User=Depends(get_current_user)) -> models.User:
        if user.role not in roles:
            raise HTTPException(403, "You do not have permission to access this area.")
        return user
    return role_dependency

def require_customer_access(user: models.User, customer_id: int) -> None:
    if user.role == "customer" and user.customer_id != customer_id:
        raise HTTPException(404, "Record not found.")

def audit(db, action, details=""):
    db.add(models.AuditLog(action=action, details=details))
    db.commit()

def add_job_update(
    db: Session,
    job_type: str,
    job_id: int,
    customer_id: int,
    status: str,
    message: str,
    actor_user_id: int | None = None,
) -> models.JobUpdate:
    update = models.JobUpdate(
        job_type=job_type,
        job_id=job_id,
        customer_id=customer_id,
        status=status,
        message=message,
        actor_user_id=actor_user_id,
    )
    db.add(update)
    return update

def send_completion_notification(
    db: Session,
    update: models.JobUpdate,
    customer: models.Customer,
    job_label: str,
) -> None:
    if not customer.whatsapp_opt_in:
        update.whatsapp_status = "not_opted_in"
        db.commit()
        return
    status, error = send_job_completed_whatsapp(
        customer.phone,
        customer.name,
        job_label,
        update.job_id,
    )
    update.whatsapp_status = status
    update.whatsapp_error = error[:500] if error else None
    db.commit()
    if status != "sent":
        audit(
            db,
            f"notification.whatsapp_{status}",
            f"job_type={update.job_type}, job_id={update.job_id}, error={error}",
        )

def job_update_payload(update: models.JobUpdate, include_delivery: bool = False) -> dict:
    payload = {
        "id": update.id,
        "job_type": update.job_type,
        "job_id": update.job_id,
        "status": update.status,
        "message": update.message,
        "created_at": update.created_at,
    }
    if include_delivery:
        payload["whatsapp_status"] = update.whatsapp_status
        payload["whatsapp_error"] = update.whatsapp_error
    return payload

async def store_upload(
    file: UploadFile,
    prefix: str,
    allowed_extensions: set[str],
    allowed_types: str,
) -> str:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in allowed_extensions:
        raise HTTPException(400, f"Use {allowed_types}.")
    path = os.path.join(UPLOAD_DIR, f"{prefix}_{os.urandom(8).hex()}{ext}")
    saved = False
    try:
        size = 0
        with open(path, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > 20 * 1024 * 1024:
                    raise HTTPException(413, "File exceeds 20 MB limit.")
                out.write(chunk)
        saved = True
    finally:
        if not saved and os.path.exists(path):
            os.remove(path)
    return path

def seed(db):
    if not db.query(models.User).filter_by(role="admin").first():
        if INITIAL_ADMIN_EMAIL or INITIAL_ADMIN_PASSWORD:
            admin_email = INITIAL_ADMIN_EMAIL.strip().lower()
            if not admin_email or not INITIAL_ADMIN_PASSWORD:
                raise RuntimeError(
                    "Set both INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD to bootstrap the first administrator."
                )
            if (
                "@" not in admin_email
                or len(admin_email) > 160
                or any(char.isspace() for char in admin_email)
            ):
                raise RuntimeError("INITIAL_ADMIN_EMAIL must be a valid email address.")
            if len(INITIAL_ADMIN_PASSWORD) < 12:
                raise RuntimeError("INITIAL_ADMIN_PASSWORD must contain at least 12 characters.")
            if len(INITIAL_ADMIN_PASSWORD.encode("utf-8")) > 72:
                raise RuntimeError(
                    "INITIAL_ADMIN_PASSWORD must contain no more than 72 UTF-8 bytes for bcrypt."
                )
            if db.query(models.User).filter_by(email=admin_email).first():
                raise RuntimeError("INITIAL_ADMIN_EMAIL is already used by another account.")
            db.add(models.User(
                name="Administrator",
                email=admin_email,
                password_hash=hash_password(INITIAL_ADMIN_PASSWORD),
                role="admin",
                active=True,
            ))
        elif (
            DATABASE_URL == "sqlite:///./printbiz.db"
            and not SESSION_COOKIE_SECURE
        ):
            db.add(models.User(
                name="Administrator",
                email="admin@smartprint.local",
                password_hash=hash_password("Admin123!ChangeMe"),
                role="admin",
                active=True,
            ))
    if db.query(models.Service).count() == 0:
        defaults = [
            ("B&W printing","Printing","page",1.00),
            ("Colour printing","Printing","page",5.00),
            ("Photocopy B&W","Photocopy","page",1.00),
            ("AI document editing","AI Editing","page",5.00),
            ("Binding","Finishing","job",15.00),
            ("Lamination","Finishing","page",5.00),
        ]
        for n,c,u,p in defaults: db.add(models.Service(name=n,category=c,unit=u,unit_price=p))
    if db.query(models.Product).count() == 0:
        db.add(models.Product(name="A4 paper (ream)", sku="PAPER-A4", quantity=10, reorder_level=3, cost_price=90, selling_price=120))
        db.add(models.Product(name="Blue pen", sku="PEN-BLUE", quantity=50, reorder_level=10, cost_price=2, selling_price=3))
    db.commit()

with next(get_db()) as db:
    seed(db)

@app.get("/")
def home():
    return RedirectResponse("/login")

@app.get("/login")
def login_page():
    return FileResponse("app/static/login.html")

@app.get("/admin-recovery", include_in_schema=False)
def admin_recovery_page():
    if len(ADMIN_RESET_TOKEN.encode("utf-8")) < 32:
        raise HTTPException(404, "Not found.")
    return FileResponse("app/static/admin-recovery.html")

@app.get("/register")
def register_page():
    return FileResponse("app/static/register.html")

@app.get("/dashboard")
def dashboard_page():
    return FileResponse("app/static/index.html")

@app.get("/api/health")
def health():
    return {"status":"ok","business":BUSINESS_NAME,"currency":CURRENCY}

@app.get("/api/ai/status")
def ai_status(user: models.User=Depends(require_roles("admin", "staff"))):
    return {"available": ai_is_configured(), "model": OPENAI_MODEL}

@app.post("/api/auth/login")
def login(data: schemas.LoginIn, response: Response, db: Session=Depends(get_db)):
    email=data.email.strip().lower()
    user=db.query(models.User).filter_by(email=email).first()
    if not user or not user.active or not verify_password(data.password,user.password_hash):
        raise HTTPException(401,"Email or password is incorrect.")
    token=create_session_token(user.id,user.password_hash,SESSION_SECRET,SESSION_TTL_SECONDS)
    response.set_cookie(
        "printbiz_session",
        token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    return user_payload(user)

@app.post("/api/recovery/admin-password", include_in_schema=False)
def recover_admin_password(
    data: schemas.AdminRecoveryIn,
    response: Response,
    db: Session = Depends(get_db),
):
    if len(ADMIN_RESET_TOKEN.encode("utf-8")) < 32:
        raise HTTPException(404, "Not found.")
    if not hmac.compare_digest(
        data.recovery_token.encode("utf-8"),
        ADMIN_RESET_TOKEN.encode("utf-8"),
    ):
        raise HTTPException(401, "Recovery token is invalid.")

    current_email = data.current_email.strip().lower()
    new_email = (data.new_email or current_email).strip().lower()
    if any(char.isspace() for char in current_email) or "@" not in current_email:
        raise HTTPException(422, "Enter a valid current administrator email.")
    if any(char.isspace() for char in new_email) or "@" not in new_email:
        raise HTTPException(422, "Enter a valid new administrator email.")

    token_fingerprint = hashlib.sha256(data.recovery_token.encode("utf-8")).hexdigest()
    if db.get(models.AdminResetTokenUse, token_fingerprint):
        raise HTTPException(409, "This recovery token has already been used.")

    account = db.query(models.User).filter_by(email=current_email, role="admin").first()
    if not account:
        raise HTTPException(404, "No administrator account found with that email.")
    if new_email != current_email and db.query(models.User).filter_by(email=new_email).first():
        raise HTTPException(409, "Another account already uses the new email address.")

    account.email = new_email
    account.password_hash = hash_password(data.new_password)
    db.add(models.AdminResetTokenUse(token_fingerprint=token_fingerprint))
    db.add(models.AuditLog(
        action="admin.credentials_reset_via_web",
        details=f"user_id={account.id}",
    ))
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        if db.get(models.AdminResetTokenUse, token_fingerprint):
            raise HTTPException(409, "This recovery token has already been used.") from error
        raise

    response.headers["Cache-Control"] = "no-store"
    return {"status": "credentials_updated", "email": new_email}

@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie("printbiz_session",path="/",httponly=True,samesite="strict")
    return {"status":"signed_out"}

@app.post("/api/auth/password")
def change_password(data: schemas.PasswordChangeIn, db: Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    account=db.get(models.User,user.id)
    if not account or not verify_password(data.current_password,account.password_hash):
        raise HTTPException(400,"Current password is incorrect.")
    if verify_password(data.new_password,account.password_hash):
        raise HTTPException(400,"Choose a password you have not used before.")
    account.password_hash=hash_password(data.new_password)
    db.commit()
    audit(db,"user.password_changed",f"user_id={account.id}")
    return {"status":"password_changed"}

@app.get("/api/auth/me")
def current_session(user: models.User=Depends(get_current_user), db: Session=Depends(get_db)):
    payload=user_payload(user)
    if user.role=="customer" and user.customer_id:
        customer=db.get(models.Customer,user.customer_id)
        payload["customer"]={
            "visits":customer.visits,
            "loyalty_points":customer.loyalty_points,
            "discount_percent":int(discount_rate(customer.visits)*100),
        } if customer else None
    return payload

@app.post("/api/auth/register")
def register_customer(data: schemas.CustomerRegistrationIn, db: Session=Depends(get_db)):
    email=data.email.strip().lower()
    if "@" not in email or any(char.isspace() for char in email):
        raise HTTPException(422,"Enter a valid email address.")
    if db.query(models.User).filter_by(email=email).first():
        raise HTTPException(409,"An account with that email already exists.")
    if db.query(models.Customer).filter_by(phone=data.phone).first():
        raise HTTPException(409,"This phone number is already registered. Ask staff to link your account.")
    customer=models.Customer(
        name=data.name.strip(),
        phone=data.phone.strip(),
        email=email,
        whatsapp_opt_in=data.whatsapp_updates,
    )
    db.add(customer)
    db.flush()
    account=models.User(
        name=customer.name,
        email=email,
        password_hash=hash_password(data.password),
        role="customer",
        active=True,
        customer_id=customer.id,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    audit(db,"customer.account_created",f"customer_id={customer.id}")
    return user_payload(account)

@app.get("/api/admin/users")
def list_users(db: Session=Depends(get_db), user: models.User=Depends(require_roles("admin"))):
    accounts=db.query(models.User).order_by(models.User.created_at.desc()).all()
    return [{
        **user_payload(account),
        "active":account.active,
        "created_at":account.created_at,
    } for account in accounts]

@app.post("/api/admin/users")
def create_staff_account(data: schemas.StaffUserIn, db: Session=Depends(get_db), user: models.User=Depends(require_roles("admin"))):
    email=data.email.strip().lower()
    if "@" not in email or any(char.isspace() for char in email):
        raise HTTPException(422,"Enter a valid email address.")
    if db.query(models.User).filter_by(email=email).first():
        raise HTTPException(409,"An account with that email already exists.")
    account=models.User(
        name=data.name.strip(),
        email=email,
        password_hash=hash_password(data.password),
        role="staff",
        active=True,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    audit(db,"staff.account_created",f"user_id={account.id}")
    return user_payload(account)

@app.patch("/api/admin/users/{user_id}/active")
def update_user_access(user_id: int, data: schemas.UserActiveIn, db: Session=Depends(get_db), user: models.User=Depends(require_roles("admin"))):
    account=db.get(models.User,user_id)
    if not account:
        raise HTTPException(404,"User not found.")
    if account.id==user.id and not data.active:
        raise HTTPException(400,"You cannot deactivate your own account.")
    if account.role=="admin" and account.active and not data.active:
        active_admins=db.query(models.User).filter_by(role="admin",active=True).count()
        if active_admins<=1:
            raise HTTPException(400,"The last active administrator cannot be deactivated.")
    account.active=data.active
    db.commit()
    audit(db,"user.access_updated",f"user_id={account.id}, active={account.active}")
    return {"id":account.id,"active":account.active}

@app.post("/api/customers")
def create_customer(data: schemas.CustomerIn, db: Session=Depends(get_db), user: models.User=Depends(require_roles("admin","staff"))):
    if db.query(models.Customer).filter_by(phone=data.phone).first():
        raise HTTPException(409, "A customer with this phone number already exists.")
    customer=models.Customer(**data.model_dump())
    db.add(customer); db.commit(); db.refresh(customer)
    audit(db,"customer.created",f"customer_id={customer.id}")
    return customer

@app.get("/api/customers")
def customers(db: Session=Depends(get_db), user: models.User=Depends(require_roles("admin","staff"))):
    return db.query(models.Customer).order_by(models.Customer.name).all()

@app.get("/api/customers/{customer_id}")
def customer_detail(customer_id:int, db:Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    require_customer_access(user,customer_id)
    c=db.get(models.Customer,customer_id)
    if not c: raise HTTPException(404,"Customer not found")
    return {"customer":c,"discount_rate":discount_rate(c.visits),"discount_percent":int(discount_rate(c.visits)*100)}

@app.get("/api/services")
def services(db:Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    return db.query(models.Service).filter_by(active=True).all()

@app.post("/api/services")
def add_service(data:schemas.ServiceIn, db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin"))):
    if db.query(models.Service).filter_by(name=data.name).first():
        raise HTTPException(409,"A service with this name already exists.")
    s=models.Service(**data.model_dump()); db.add(s); db.commit(); db.refresh(s)
    audit(db,"service.created",f"service_id={s.id}")
    return s

@app.patch("/api/services/{service_id}/price")
def update_service_price(
    service_id: int,
    data: schemas.ServicePriceIn,
    db: Session=Depends(get_db),
    user: models.User=Depends(require_roles("admin")),
):
    service = db.get(models.Service, service_id)
    if not service:
        raise HTTPException(404, "Service not found.")
    service.unit_price = data.unit_price
    db.commit()
    audit(db, "service.price_updated", f"service_id={service.id}, unit_price={service.unit_price}")
    return {"service_id": service.id, "unit_price": service.unit_price}

@app.get("/api/products")
def products(db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin","staff"))):
    return db.query(models.Product).filter_by(active=True).all()

@app.post("/api/products")
def add_product(data:schemas.ProductIn, db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin"))):
    if data.sku and db.query(models.Product).filter_by(sku=data.sku).first():
        raise HTTPException(409,"SKU already exists")
    p=models.Product(**data.model_dump()); db.add(p); db.commit(); db.refresh(p)
    audit(db,"product.created",f"product_id={p.id}")
    return p

@app.patch("/api/products/{product_id}/price")
def update_product_price(
    product_id: int,
    data: schemas.ProductPriceIn,
    db: Session=Depends(get_db),
    user: models.User=Depends(require_roles("admin")),
):
    product = db.get(models.Product, product_id)
    if not product:
        raise HTTPException(404, "Product not found.")
    product.cost_price = data.cost_price
    product.selling_price = data.selling_price
    db.commit()
    audit(
        db,
        "product.price_updated",
        f"product_id={product.id}, cost_price={product.cost_price}, selling_price={product.selling_price}",
    )
    return {
        "product_id": product.id,
        "cost_price": product.cost_price,
        "selling_price": product.selling_price,
    }

@app.post("/api/products/{product_id}/stock")
def adjust_stock(product_id:int, quantity:int=Form(...), db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin","staff"))):
    p=db.get(models.Product,product_id)
    if not p: raise HTTPException(404,"Product not found")
    if p.quantity+quantity<0: raise HTTPException(400,"Insufficient stock")
    p.quantity+=quantity; db.commit()
    audit(db,"inventory.adjusted",f"product={product_id}, change={quantity}")
    return {"product_id":p.id,"quantity":p.quantity}

@app.get("/api/machines")
def list_machines(
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("admin", "staff")),
):
    machines = db.query(models.Machine).order_by(models.Machine.name).all()
    return [machine_payload(machine) for machine in machines]

@app.post("/api/machines")
def add_machine(
    data: schemas.MachineIn,
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("admin")),
):
    machine_name = data.name.strip()
    if len(machine_name) < 2:
        raise HTTPException(422, "Machine name must contain at least 2 characters.")
    serial_number = data.serial_number.strip() if data.serial_number else None
    serial_number = serial_number or None
    if serial_number and db.query(models.Machine).filter_by(serial_number=serial_number).first():
        raise HTTPException(409, "A machine with this serial number already exists.")
    machine = models.Machine(
        name=machine_name,
        model=data.model.strip() if data.model and data.model.strip() else None,
        serial_number=serial_number,
        location=data.location.strip() if data.location and data.location.strip() else None,
        status=data.status,
        notes=data.notes.strip() if data.notes and data.notes.strip() else None,
    )
    db.add(machine)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(409, "A machine with this serial number already exists.") from error
    db.refresh(machine)
    audit(db, "machine.created", f"machine_id={machine.id}")
    return machine_payload(machine)

def save_order(customer: models.Customer, items: list[schemas.OrderLineIn], notes: str | None, db: Session):
    if not items: raise HTTPException(400,"At least one order item is required")
    subtotal=money(sum(item.quantity*item.unit_price for item in items))
    rate=discount_rate(customer.visits)
    discount=money(subtotal*rate)
    order=models.Order(customer_id=customer.id,subtotal=subtotal,discount=discount,total=money(subtotal-discount),notes=notes)
    db.add(order); db.flush()
    for item in items:
        db.add(models.OrderItem(order_id=order.id,description=item.description,quantity=item.quantity,unit_price=item.unit_price,line_total=money(item.quantity*item.unit_price)))
    add_job_update(
        db, "print", order.id, customer.id, "received",
        "Your print request was received and added to the production queue.",
    )
    db.commit(); db.refresh(order)
    audit(db,"order.created",f"order_id={order.id}")
    return {"order_id":order.id,"subtotal":order.subtotal,"discount_rate":rate,"discount":order.discount,"total":order.total,"currency":CURRENCY}

@app.post("/api/orders")
def create_order(data:schemas.OrderIn, db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin","staff"))):
    customer=db.get(models.Customer,data.customer_id)
    if not customer: raise HTTPException(404,"Customer not found")
    return save_order(customer,data.items,data.notes,db)

@app.patch("/api/orders/{order_id}/production-status")
def update_order_production_status(
    order_id: int,
    data: schemas.OrderProductionStatusIn,
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("admin", "staff")),
):
    order = db.get(models.Order, order_id)
    if not order:
        raise HTTPException(404, "Order not found.")
    transitions = {
        "received": {"in_progress"},
        "in_progress": {"ready"},
        "ready": {"in_progress", "completed"},
    }
    if data.status not in transitions.get(order.production_status, set()):
        raise HTTPException(
            409,
            f"Cannot move this job from {order.production_status} to {data.status}.",
        )
    order.production_status = data.status
    status_messages = {
        "in_progress": "Work has started on your print job.",
        "ready": "Your print job is ready for collection.",
        "completed": "Your print job is complete. Thank you for choosing Stationary Hub.",
    }
    update = add_job_update(
        db, "print", order.id, order.customer_id, data.status,
        status_messages[data.status], user.id,
    )
    db.commit()
    if data.status == "completed":
        customer = db.get(models.Customer, order.customer_id)
        send_completion_notification(db, update, customer, "print")
    audit(db, "order.production_status_updated", f"order_id={order.id}, status={data.status}")
    return {
        "order_id": order.id,
        "production_status": order.production_status,
        "whatsapp_status": update.whatsapp_status,
    }

@app.post("/api/portal/orders")
def create_portal_order(data:schemas.PortalOrderIn, db:Session=Depends(get_db), user: models.User=Depends(require_roles("customer"))):
    if not user.customer_id:
        raise HTTPException(403,"This account is not linked to a customer profile.")
    customer=db.get(models.Customer,user.customer_id)
    if not customer:
        raise HTTPException(404,"Customer profile not found.")
    items=[]
    for requested in data.items:
        service=db.get(models.Service,requested.service_id)
        if not service or not service.active:
            raise HTTPException(422,f"Service {requested.service_id} is not available.")
        items.append(schemas.OrderLineIn(
            description=service.name,
            quantity=requested.quantity,
            unit_price=service.unit_price,
        ))
    return save_order(customer,items,data.notes,db)

@app.get("/api/orders")
def list_orders(db:Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    query=db.query(models.Order)
    if user.role=="customer":
        query=query.filter_by(customer_id=user.customer_id)
    orders=query.order_by(models.Order.created_at.desc()).limit(200).all()
    return [{
        "id":order.id,
        "customer_id":order.customer_id,
        "status":order.status,
        "production_status":order.production_status,
        "subtotal":order.subtotal,
        "discount":order.discount,
        "total":order.total,
        "paid":order.paid,
        "notes":order.notes,
        "created_at":order.created_at,
        "has_attachment":bool(order.attachment_path),
    } for order in orders]

@app.get("/api/job-updates")
def list_job_updates(
    job_type: Literal["print", "document", "tshirt"],
    job_id: int,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    models_by_type = {
        "print": models.Order,
        "document": models.DocumentJob,
        "tshirt": models.TshirtOrder,
    }
    job = db.get(models_by_type[job_type], job_id)
    if not job:
        raise HTTPException(404, "Job not found.")
    require_customer_access(user, job.customer_id)
    updates = db.query(models.JobUpdate).filter_by(
        job_type=job_type, job_id=job_id, customer_id=job.customer_id
    ).order_by(models.JobUpdate.created_at, models.JobUpdate.id).all()
    return [job_update_payload(update, user.role != "customer") for update in updates]

@app.post("/api/job-updates")
def create_job_progress_update(
    data: schemas.JobProgressUpdateIn,
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("admin", "staff")),
):
    models_by_type = {
        "print": models.Order,
        "document": models.DocumentJob,
        "tshirt": models.TshirtOrder,
    }
    job = db.get(models_by_type[data.job_type], data.job_id)
    if not job:
        raise HTTPException(404, "Job not found.")
    message = data.message.strip()
    if len(message) < 3:
        raise HTTPException(422, "Progress update must contain at least 3 characters.")
    update = add_job_update(
        db,
        data.job_type,
        data.job_id,
        job.customer_id,
        "progress_update",
        message,
        user.id,
    )
    db.commit()
    db.refresh(update)
    audit(db, "job.progress_updated", f"job_type={data.job_type}, job_id={data.job_id}")
    return job_update_payload(update)

@app.get("/api/notifications")
def customer_notifications(
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("customer")),
):
    if not user.customer_id:
        raise HTTPException(403, "This account is not linked to a customer profile.")
    updates = db.query(models.JobUpdate).filter_by(
        customer_id=user.customer_id
    ).order_by(models.JobUpdate.created_at.desc(), models.JobUpdate.id.desc()).limit(100).all()
    return [job_update_payload(update) for update in updates]

@app.get("/api/orders/{order_id}")
def order_detail(order_id:int, db:Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    o=db.get(models.Order,order_id)
    if not o: raise HTTPException(404,"Order not found")
    require_customer_access(user,o.customer_id)
    return {
        "order":{
            "id":o.id,
            "customer_id":o.customer_id,
            "status":o.status,
            "production_status":o.production_status,
            "subtotal":o.subtotal,
            "discount":o.discount,
            "total":o.total,
            "paid":o.paid,
            "notes":o.notes,
            "created_at":o.created_at,
            "has_attachment":bool(o.attachment_path),
        },
        "items":o.items,
        "balance":money(o.total-o.paid),
    }

@app.post("/api/orders/{order_id}/attachment")
async def upload_order_attachment(
    order_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    order = db.get(models.Order, order_id)
    if not order:
        raise HTTPException(404, "Order not found.")
    require_customer_access(user, order.customer_id)
    path = await store_upload(
        file,
        f"order_{order.id}",
        {".pdf", ".docx", ".txt", ".png", ".jpg", ".jpeg"},
        "PDF, DOCX, TXT, PNG or JPG",
    )
    previous_path = order.attachment_path
    order.attachment_path = path
    add_job_update(
        db, "print", order.id, order.customer_id, order.production_status,
        "A print file was added to your job.", user.id,
    )
    db.commit()
    if previous_path and os.path.isfile(previous_path):
        os.remove(previous_path)
    audit(db, "order.attachment_uploaded", f"order_id={order.id}")
    return {"order_id": order.id, "filename": file.filename}

@app.get("/api/orders/{order_id}/attachment")
def download_order_attachment(
    order_id: int,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    order = db.get(models.Order, order_id)
    if not order or not order.attachment_path or not os.path.isfile(order.attachment_path):
        raise HTTPException(404, "Print file not found.")
    require_customer_access(user, order.customer_id)
    return FileResponse(order.attachment_path, filename=Path(order.attachment_path).name)

@app.post("/api/orders/{order_id}/payments")
def record_payment(order_id:int, data: schemas.PaymentIn, db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin","staff"))):
    o=db.get(models.Order,order_id)
    if not o: raise HTTPException(404,"Order not found")
    balance=money(o.total-o.paid)
    if data.amount>balance: raise HTTPException(400,"Payment exceeds outstanding balance")
    db.add(models.Payment(order_id=order_id,**data.model_dump()))
    o.paid=money(o.paid+data.amount)
    if o.paid>=o.total:
        o.status="paid"
        # One visit is counted when the order is fully paid, only once.
        customer=db.get(models.Customer,o.customer_id)
        customer.visits+=1
        customer.loyalty_points+=max(1,int(o.total//10))
    db.commit()
    audit(db,"payment.recorded",f"order={order_id}, amount={data.amount}, method={data.method}")
    return {"order_id":o.id,"paid":o.paid,"balance":money(o.total-o.paid),"status":o.status}

@app.get("/api/documents")
def list_document_jobs(db:Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    query=db.query(models.DocumentJob,models.Customer.name).join(
        models.Customer,models.DocumentJob.customer_id==models.Customer.id
    )
    if user.role=="customer":
        query=query.filter(models.DocumentJob.customer_id==user.customer_id)
    jobs=query.order_by(models.DocumentJob.created_at.desc()).limit(100).all()
    return [{
        "id":job.id,
        "customer_id":job.customer_id,
        "customer_name":customer_name,
        "original_name":job.original_name,
        "requested_pages":job.requested_pages,
        "job_type":job.job_type,
        "status":job.status,
        "has_edited_text":bool(job.edited_text),
        "has_original_file":bool(job.stored_path and os.path.isfile(job.stored_path)),
        "extracted_characters":len(job.extracted_text or ""),
        "created_at":job.created_at,
    } for job,customer_name in jobs]

@app.post("/api/documents/drafts")
def create_document_draft(
    data: schemas.DocumentDraftIn,
    db: Session=Depends(get_db),
    user: models.User=Depends(require_roles("admin", "staff")),
):
    customer = db.get(models.Customer, data.customer_id)
    if not customer:
        raise HTTPException(404, "Customer not found.")
    job = models.DocumentJob(
        customer_id=customer.id,
        original_name=data.title.strip(),
        stored_path="",
        requested_pages=data.requested_pages,
        job_type="assignment",
        status="uploaded",
        extracted_text="",
    )
    db.add(job)
    db.flush()
    add_job_update(
        db, "document", job.id, customer.id, job.status,
        "A new assignment draft was opened for staff preparation.", user.id,
    )
    db.commit()
    db.refresh(job)
    audit(db, "document.assignment_draft_created", f"job_id={job.id}")
    return {"job_id": job.id, "status": job.status, "title": job.original_name}

@app.post("/api/documents/upload")
async def upload_document(customer_id:int|None=Form(None), requested_pages:int|None=Form(None), job_type:str=Form("editing"), file:UploadFile=File(...), db:Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    if user.role=="customer":
        customer_id=user.customer_id
    elif customer_id is None:
        raise HTTPException(422,"Select a customer for this document job.")
    if customer_id is None:
        raise HTTPException(403,"This account is not linked to a customer profile.")
    customer=db.get(models.Customer,customer_id)
    if not customer: raise HTTPException(404,"Customer not found")
    if requested_pages is not None and requested_pages<1: raise HTTPException(400,"Requested pages must be positive")
    path=await store_upload(file,"document",{".pdf",".docx",".txt"},"PDF, DOCX or TXT")
    safe_name=Path(path).name
    job=models.DocumentJob(customer_id=customer_id,original_name=file.filename or safe_name,stored_path=path,requested_pages=requested_pages,job_type=job_type)
    db.add(job); db.flush()
    add_job_update(
        db, "document", job.id, customer_id, "uploaded",
        "Your document was received and added to the work queue.", user.id,
    )
    db.commit(); db.refresh(job)
    extraction_error = None
    try:
        job.extracted_text=extract_text(path)
        job.status="text_extracted" if job.extracted_text.strip() else "uploaded"
    except Exception as error:
        job.status="uploaded"
        extraction_error = str(error)
    if job.status == "text_extracted":
        add_job_update(
            db, "document", job.id, customer_id, job.status,
            "The document is ready for staff review and editing.", user.id,
        )
    else:
        add_job_update(
            db, "document", job.id, customer_id, job.status,
            f"The document was received, but text extraction needs staff review: {extraction_error or 'No readable text was found.'}",
            user.id,
        )
    db.commit()
    audit(db,"document.uploaded",f"job_id={job.id}, status={job.status}")
    return {
        "job_id":job.id,
        "filename":job.original_name,
        "status":job.status,
        "extracted_characters":len(job.extracted_text or ""),
        "message":extraction_error,
    }

@app.get("/api/documents/{job_id}/editor")
def get_document_editor(
    job_id: int,
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("admin", "staff")),
):
    job = db.get(models.DocumentJob, job_id)
    if not job:
        raise HTTPException(404, "Document job not found.")
    return {
        "id": job.id,
        "filename": job.original_name,
        "status": job.status,
        "text": job.edited_text if job.edited_text is not None else job.extracted_text or "",
    }

@app.put("/api/documents/{job_id}/editor")
def save_document_editor(
    job_id: int,
    data: schemas.DocumentTextIn,
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("admin", "staff")),
):
    job = db.get(models.DocumentJob, job_id)
    if not job:
        raise HTTPException(404, "Document job not found.")
    job.edited_text = data.text
    job.status = "edited"
    add_job_update(
        db, "document", job.id, job.customer_id, "edited",
        "Staff saved an edited copy of your document.", user.id,
    )
    db.commit()
    audit(db, "document.editor_saved", f"job_id={job.id}")
    return {"job_id": job.id, "status": job.status}

@app.patch("/api/documents/{job_id}/status")
def update_document_status(
    job_id: int,
    data: schemas.DocumentStatusIn,
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("admin", "staff")),
):
    job = db.get(models.DocumentJob, job_id)
    if not job:
        raise HTTPException(404, "Document job not found.")
    transitions = {
        "uploaded": {"in_progress"},
        "text_extracted": {"in_progress"},
        "edited": {"in_progress"},
        "in_progress": {"ready"},
        "ready": {"in_progress", "completed"},
    }
    if data.status not in transitions.get(job.status, set()):
        raise HTTPException(
            409, f"Cannot move this document from {job.status} to {data.status}."
        )
    job.status = data.status
    messages = {
        "in_progress": "Staff started processing your document.",
        "ready": "Your document is ready for review or collection.",
        "completed": "Your document job is complete. Thank you for choosing Stationary Hub.",
    }
    update = add_job_update(
        db, "document", job.id, job.customer_id, job.status,
        messages[job.status], user.id,
    )
    db.commit()
    if job.status == "completed":
        customer = db.get(models.Customer, job.customer_id)
        send_completion_notification(db, update, customer, "document")
    audit(db, "document.status_updated", f"job_id={job.id}, status={job.status}")
    return {
        "job_id": job.id,
        "status": job.status,
        "whatsapp_status": update.whatsapp_status,
    }

@app.post("/api/documents/{job_id}/ai-edit")
def edit_document(job_id:int, instruction:str=Form("Improve clarity, grammar and essay structure while preserving meaning."), db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin","staff"))):
    job=db.get(models.DocumentJob,job_id)
    if not job: raise HTTPException(404,"Document job not found")
    source_text = job.edited_text if job.edited_text is not None else job.extracted_text
    if not source_text: raise HTTPException(400,"No document text is available to improve.")
    try:
        result=ai_edit(source_text,instruction,job.requested_pages)
    except AIUnavailableError as error:
        raise HTTPException(503, str(error)) from error
    except AIProviderError as error:
        raise HTTPException(502, str(error)) from error
    job.edited_text=result; job.status="edited"
    add_job_update(
        db, "document", job.id, job.customer_id, "edited",
        "AI applied a requested revision to the assignment draft.", user.id,
    )
    db.commit()
    audit(db,"document.edited",f"job_id={job.id}")
    return {"job_id":job.id,"status":job.status,"edited_text":result,"note":"AI changes were saved. Review facts, citations, and course requirements before delivery."}

@app.post("/api/documents/{job_id}/ai-assist")
def assist_document_with_ai(
    job_id: int,
    data: schemas.DocumentAIIn,
    db: Session=Depends(get_db),
    user: models.User=Depends(require_roles("admin", "staff")),
):
    job = db.get(models.DocumentJob, job_id)
    if not job:
        raise HTTPException(404, "Document job not found.")
    if data.action == "coach" and not data.text.strip():
        raise HTTPException(400, "Add assignment text before asking the AI coach to improve it.")
    if data.action == "draft" and not data.instruction.strip():
        raise HTTPException(400, "Enter the assignment brief before asking the AI to draft.")
    instruction = data.instruction.strip()
    source_text = data.text
    if data.action == "draft":
        source_text = "\n\n".join(
            part for part in (instruction, data.text.strip()) if part
        )
        instruction = "Create an assignment draft that answers the supplied brief and uses the supplied source material."
    try:
        result = ai_assist(
            source_text,
            instruction,
            job.requested_pages,
            data.action,
        )
    except AIUnavailableError as error:
        raise HTTPException(503, str(error)) from error
    except AIProviderError as error:
        raise HTTPException(502, str(error)) from error
    job.edited_text = result
    job.status = "edited"
    update_message = (
        "AI created an assignment draft for staff review."
        if data.action == "draft"
        else "AI applied requested improvements to the assignment draft."
    )
    add_job_update(
        db, "document", job.id, job.customer_id, job.status,
        update_message, user.id,
    )
    db.commit()
    audit(db, f"document.ai_{data.action}", f"job_id={job.id}")
    return {
        "job_id": job.id,
        "status": job.status,
        "action": data.action,
        "edited_text": result,
        "note": "Changes were applied and saved. Review accuracy, citations, and your course's AI-use rules.",
    }

@app.get("/api/documents/{job_id}/download")
def download_document(job_id:int, db:Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    job=db.get(models.DocumentJob,job_id)
    if not job or not job.edited_text: raise HTTPException(404,"Edited document not found")
    require_customer_access(user,job.customer_id)
    out=Path(UPLOAD_DIR)/f"edited_{job.id}.txt"
    out.write_text(job.edited_text,encoding="utf-8")
    return FileResponse(out,filename=f"edited_document_{job.id}.txt",media_type="text/plain")

@app.get("/api/documents/{job_id}/download-word")
def download_word_document(
    job_id: int,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    job = db.get(models.DocumentJob, job_id)
    if not job or not job.edited_text:
        raise HTTPException(404, "Edited document not found.")
    require_customer_access(user, job.customer_id)
    document = WordDocument()
    normal = document.styles["Normal"]
    normal.font.name = "Arial"
    normal.font.size = Pt(11)
    for paragraph in job.edited_text.splitlines():
        document.add_paragraph(paragraph)
    output = BytesIO()
    document.save(output)
    output.seek(0)
    filename = f"edited_document_{job.id}.docx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )

@app.get("/api/documents/{job_id}/original")
def download_original_document(
    job_id: int,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    job = db.get(models.DocumentJob, job_id)
    if not job or not os.path.isfile(job.stored_path):
        raise HTTPException(404, "Original document not found.")
    require_customer_access(user, job.customer_id)
    return FileResponse(job.stored_path, filename=job.original_name)

@app.post("/api/tshirts")
def create_tshirt(data:schemas.TshirtIn, db:Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    customer_id=user.customer_id if user.role=="customer" else data.customer_id
    if customer_id is None or not db.get(models.Customer,customer_id): raise HTTPException(404,"Customer not found")
    values=data.model_dump(exclude={"customer_id"})
    if user.role=="customer":
        values["unit_price"]=0
        t=models.TshirtOrder(customer_id=customer_id,status="quotation_requested",**values)
    else:
        if values["unit_price"] is None:
            raise HTTPException(422,"Enter a unit price for this T-shirt order.")
        t=models.TshirtOrder(customer_id=customer_id,status="approved",**values)
    db.add(t); db.flush()
    add_job_update(
        db, "tshirt", t.id, customer_id, t.status,
        "Your T-shirt printing request was received.", user.id,
    )
    db.commit(); db.refresh(t)
    audit(db,"tshirt.created",f"tshirt_order_id={t.id}")
    return {
        "id":t.id,
        "customer_id":t.customer_id,
        "colour":t.colour,
        "size":t.size,
        "quantity":t.quantity,
        "unit_price":t.unit_price,
        "status":t.status,
    }

@app.get("/api/tshirts")
def list_tshirt_orders(db:Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    query=db.query(models.TshirtOrder,models.Customer.name).join(
        models.Customer,models.TshirtOrder.customer_id==models.Customer.id
    )
    if user.role=="customer":
        query=query.filter(models.TshirtOrder.customer_id==user.customer_id)
    orders=query.order_by(models.TshirtOrder.created_at.desc()).limit(100).all()
    return [{
        "id":order.id,
        "customer_id":order.customer_id,
        "customer_name":customer_name,
        "colour":order.colour,
        "size":order.size,
        "quantity":order.quantity,
        "unit_price":order.unit_price,
        "status":order.status,
        "has_design":bool(order.design_path),
        "notes":order.notes,
        "created_at":order.created_at,
    } for order,customer_name in orders]

@app.post("/api/tshirts/{order_id}/design")
async def upload_tshirt_design(order_id:int, file:UploadFile=File(...), db:Session=Depends(get_db), user: models.User=Depends(get_current_user)):
    t=db.get(models.TshirtOrder,order_id)
    if not t: raise HTTPException(404,"T-shirt order not found")
    require_customer_access(user,t.customer_id)
    path=await store_upload(file,f"design_{order_id}",{".png",".jpg",".jpeg",".pdf",".svg"},"PNG, JPG, PDF or SVG design")
    t.design_path=path
    if t.status == "quotation_requested":
        t.status = "design_received"
    add_job_update(
        db, "tshirt", t.id, t.customer_id, t.status,
        "T-shirt artwork was added to your job.", user.id,
    )
    db.commit()
    audit(db,"tshirt.design_uploaded",f"tshirt_order_id={order_id}")
    return {"order_id":order_id,"status":t.status}

@app.get("/api/tshirts/{order_id}/design")
def download_tshirt_design(
    order_id: int,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    order = db.get(models.TshirtOrder, order_id)
    if not order or not order.design_path or not os.path.isfile(order.design_path):
        raise HTTPException(404, "T-shirt design not found.")
    require_customer_access(user, order.customer_id)
    return FileResponse(order.design_path, filename=Path(order.design_path).name)

@app.patch("/api/tshirts/{order_id}/quote")
def quote_tshirt_order(
    order_id: int,
    data: schemas.TshirtQuoteIn,
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("admin", "staff")),
):
    order = db.get(models.TshirtOrder, order_id)
    if not order:
        raise HTTPException(404, "T-shirt order not found.")
    if order.status not in {"quotation_requested", "design_received", "quoted"}:
        raise HTTPException(409, "This T-shirt order is no longer awaiting a quote.")
    order.unit_price = data.unit_price
    order.status = "quoted"
    add_job_update(
        db, "tshirt", order.id, order.customer_id, order.status,
        f"The shop sent a quote of {CURRENCY} {money(order.unit_price * order.quantity):.2f}. Review it in your customer portal.",
        user.id,
    )
    db.commit()
    audit(db, "tshirt.quote_sent", f"tshirt_order_id={order.id}, unit_price={order.unit_price}")
    return {"order_id": order.id, "unit_price": order.unit_price, "status": order.status}

@app.post("/api/tshirts/{order_id}/approve")
def approve_tshirt_quote(
    order_id: int,
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("customer")),
):
    order = db.get(models.TshirtOrder, order_id)
    if not order:
        raise HTTPException(404, "T-shirt order not found.")
    require_customer_access(user, order.customer_id)
    if order.status != "quoted":
        raise HTTPException(409, "This T-shirt order is not awaiting quote approval.")
    order.status = "approved"
    add_job_update(
        db, "tshirt", order.id, order.customer_id, order.status,
        "You approved the T-shirt quote. The shop can begin production.",
        user.id,
    )
    db.commit()
    audit(db, "tshirt.quote_approved", f"tshirt_order_id={order.id}")
    return {"order_id": order.id, "status": order.status}

@app.patch("/api/tshirts/{order_id}/production-status")
def update_tshirt_production_status(
    order_id: int,
    data: schemas.TshirtProductionStatusIn,
    db: Session = Depends(get_db),
    user: models.User = Depends(require_roles("admin", "staff")),
):
    order = db.get(models.TshirtOrder, order_id)
    if not order:
        raise HTTPException(404, "T-shirt order not found.")
    transitions = {
        "approved": {"in_production"},
        "in_production": {"ready"},
        "ready": {"in_production", "completed"},
    }
    if data.status not in transitions.get(order.status, set()):
        raise HTTPException(
            409,
            f"Cannot move this T-shirt order from {order.status} to {data.status}.",
        )
    order.status = data.status
    status_messages = {
        "in_production": "Production has started on your T-shirt order.",
        "ready": "Your T-shirt order is ready for collection.",
        "completed": "Your T-shirt order is complete. Thank you for choosing Stationary Hub.",
    }
    update = add_job_update(
        db, "tshirt", order.id, order.customer_id, data.status,
        status_messages[data.status], user.id,
    )
    db.commit()
    if data.status == "completed":
        customer = db.get(models.Customer, order.customer_id)
        send_completion_notification(db, update, customer, "T-shirt")
    audit(db, "tshirt.production_status_updated", f"tshirt_order_id={order.id}, status={data.status}")
    return {
        "order_id": order.id,
        "status": order.status,
        "whatsapp_status": update.whatsapp_status,
    }

@app.post("/api/expenses")
def add_expense(data:schemas.ExpenseIn, db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin"))):
    e=models.Expense(**data.model_dump()); db.add(e); db.commit(); db.refresh(e)
    audit(db,"expense.created",f"expense_id={e.id}, amount={e.amount}")
    return e

@app.get("/api/expenses")
def list_expenses(db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin"))):
    return db.query(models.Expense).order_by(models.Expense.created_at.desc()).limit(100).all()

@app.get("/api/dashboard")
def dashboard(db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin","staff"))):
    orders=db.query(models.Order).count()
    customers=db.query(models.Customer).count()
    pending=db.query(models.Order).filter(models.Order.status!="paid").count()
    open_jobs=db.query(models.Order).filter(models.Order.production_status!="completed").count()
    low_stock=db.query(models.Product).filter(models.Product.quantity<=models.Product.reorder_level).count()
    summary={
        "orders":orders,
        "customers":customers,
        "pending_orders":pending,
        "open_jobs":open_jobs,
        "low_stock_products":low_stock,
        "currency":CURRENCY,
    }
    if user.role=="admin":
        sales=db.query(func.coalesce(func.sum(models.Order.paid),0)).scalar() or 0
        expenses=db.query(func.coalesce(func.sum(models.Expense.amount),0)).scalar() or 0
        summary.update({
            "sales_received":money(sales),
            "expenses":money(expenses),
            "cash_surplus_before_other_costs":money(sales-expenses),
        })
    return summary

@app.get("/api/reports/daily")
def daily_report(db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin"))):
    from datetime import datetime, time
    start=datetime.combine(datetime.utcnow().date(),time.min)
    end=datetime.combine(datetime.utcnow().date(),time.max)
    orders=db.query(models.Order).filter(models.Order.created_at>=start,models.Order.created_at<=end).all()
    payments=db.query(models.Payment).filter(models.Payment.created_at>=start,models.Payment.created_at<=end).all()
    expenses=db.query(models.Expense).filter(models.Expense.created_at>=start,models.Expense.created_at<=end).all()
    return {
        "date":start.date().isoformat(),
        "orders":len(orders),
        "sales_received":money(sum(p.amount for p in payments)),
        "expenses":money(sum(e.amount for e in expenses)),
        "cash_after_expenses":money(sum(p.amount for p in payments)-sum(e.amount for e in expenses)),
        "amount_owing":money(sum(o.total-o.paid for o in orders)),
        "profit_note":"Cash after recorded expenses only; product costs, tax and other overhead are not included.",
    }

@app.get("/api/reports/monthly")
def monthly_report(year:int|None=None, month:int|None=None, db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin"))):
    from datetime import datetime
    now=datetime.utcnow()
    year=year or now.year
    month=month or now.month
    if month<1 or month>12:
        raise HTTPException(422,"Month must be between 1 and 12")
    try:
        start=datetime(year,month,1)
        end=datetime(year+1,1,1) if month==12 else datetime(year,month+1,1)
    except ValueError:
        raise HTTPException(422,"Year is not valid")
    orders=db.query(models.Order).filter(models.Order.created_at>=start,models.Order.created_at<end).all()
    payments=db.query(models.Payment).filter(models.Payment.created_at>=start,models.Payment.created_at<end).all()
    expenses=db.query(models.Expense).filter(models.Expense.created_at>=start,models.Expense.created_at<end).all()
    received=sum(payment.amount for payment in payments)
    expense_total=sum(expense.amount for expense in expenses)
    return {
        "year":year,
        "month":month,
        "orders":len(orders),
        "sales_received":money(received),
        "expenses":money(expense_total),
        "cash_after_expenses":money(received-expense_total),
        "amount_owing":money(sum(order.total-order.paid for order in orders)),
        "profit_note":"Cash after recorded expenses only; product costs, tax and other overhead are not included.",
    }

@app.get("/api/audit")
def audit_logs(db:Session=Depends(get_db), user: models.User=Depends(require_roles("admin"))):
    return db.query(models.AuditLog).order_by(models.AuditLog.created_at.desc()).limit(100).all()
