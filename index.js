const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const dotenv = require("dotenv").config();
const nodemailer = require("nodemailer");
const axios = require("axios");
const crypto = require("crypto");
const app = express();
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  })
);

const PORT = process.env.PORT || 8080;

// Tự động xóa các email chưa xác thực OTP sau 5 phút
setInterval(async () => {
  try {
    const now = new Date();
    const expiredUsers = await userModel.find({ otpExpiresAt: { $lt: now } });
    if (expiredUsers.length > 0) {
      const userIds = expiredUsers.map((user) => user._id);
      await userModel.deleteMany({ _id: { $in: userIds } });
      console.log(`Deleted ${userIds.length} expired users.`);
    }
  } catch (error) {
    console.error("Error deleting expired users:", error);
  }
}, 60 * 1000); // Kiểm tra mỗi phút

//mongodb connection
mongoose.set("strictQuery", false);
mongoose
  .connect(process.env.MONGODB_URL)
  .then(() => console.log("Connected to Database"))
  .catch((err) => console.log("Error connecting to MongoDB:", err));

// Schemas
const userSchema = mongoose.Schema({
  firstName: {
    type: String,
    required: true,
  },
  lastName: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    unique: true,
    required: true,
  },
  password: {
    type: String,
    required: true,
  },
  confirmPassword: {
    type: String,
    required: true,
  },
  image: {
    type: String,
    required: true,
  },
  otp: String,
  otpExpiresAt: Date,
  isVerified: {
    type: Boolean,
    default: false,
  },
  resetOtp: String,
  resetOtpExpires: Date,
});
const userModel = mongoose.model("user", userSchema);

const productSchema = mongoose.Schema({
  name: String,
  category: String,
  image: String,
  price: String,
  description: String,
});
const productModel = mongoose.model("product", productSchema);

const contactSchema = mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  message: String,
  createdAt: { type: Date, default: Date.now },
});
const contactModel = mongoose.model("Contact", contactSchema);

const discountSchema = mongoose.Schema({
  code: { type: String, required: true },
  type: { type: String, required: true },
  value: { type: Number, required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },

  timeFrame: {
    start: { type: String, required: true },
    end: { type: String, required: true },
  },
  minimumOrderValue: { type: Number, required: true },
  minimumItems: { type: Number, required: true },
  applicableCategories: { type: [String], required: true },
  usageLimit: { type: Number, required: true },
});
const discountModel = mongoose.model("Discount", discountSchema);

// --- Thêm các API cho PayOS ---
const router = express.Router();
const PAYOS_API_KEY = process.env.PAYOS_API_KEY;
const PAYOS_CLIENT_ID = process.env.PAYOS_CLIENT_ID; // Thêm client-id
const PAYOS_ENDPOINT = "https://api-merchant.payos.vn/v2/payment-requests";

router.post("/api/create-payos-payment", async (req, res) => {
  try {
    const { totalPrice } = req.body; // Nhận tổng tiền từ frontend
    const expiredAt = Math.floor(Date.now() / 1000) + 3600; // Hết hạn sau 1 giờ
    const orderCode = Math.floor(Math.random() * 1000000000); // Mã đơn hàng số nguyên

    const payload = {
      amount: totalPrice,
      description: "Thanh toán đơn hàng",
      returnUrl: `${process.env.FRONTEND_URL}/success`, // URL khi thanh toán thành công
      cancelUrl: `${process.env.FRONTEND_URL}/cancel`, // URL khi người dùng hủy
      failedUrl: `${process.env.FRONTEND_URL}/failed`, // URL khi thanh toán thất bại
      orderCode: orderCode,
      expiredAt: expiredAt,
    };

    //  **Tạo chữ ký signature** (Sort theo alphabet như tài liệu PayOS)
    const dataString = `amount=${payload.amount}&cancelUrl=${payload.cancelUrl}&description=${payload.description}&orderCode=${payload.orderCode}&returnUrl=${payload.returnUrl}`;
    const signature = crypto
      .createHmac("sha256", process.env.PAYOS_CHECKSUM_KEY)
      .update(dataString)
      .digest("hex");

    // Gửi request đến PayOS
    const response = await axios.post(
      PAYOS_ENDPOINT,
      { ...payload, signature }, // Thêm signature vào payload
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": PAYOS_API_KEY,
          "x-client-id": PAYOS_CLIENT_ID,
          // "x-partner-code": PAYOS_PARTNER_CODE,
        },
      }
    );

    // Kiểm tra và trả checkoutUrl về cho frontend
    if (response.data && response.data.data && response.data.data.checkoutUrl) {
      console.log("✅ Đã tạo phiên thanh toán thành công:", response.data);
      res.json({ checkoutUrl: response.data.data.checkoutUrl });
    } else {
      console.error("❌ Lỗi khi tạo phiên thanh toán PayOS:", response.data);
      res.status(500).json({ error: "Không thể tạo phiên thanh toán PayOS." });
    }
  } catch (error) {
    console.error("❌ Lỗi khi gọi API PayOS:", error);
    res
      .status(500)
      .json({ error: "Đã xảy ra lỗi khi tạo yêu cầu thanh toán." });
  }
});
router.post("/api/payos-webhook", async (req, res) => {
  try {
    const { status, orderCode, signature } = req.body; // Nhận dữ liệu từ webhook

    console.log(
      `Webhook PayOS: Trạng thái = ${status}, Mã đơn hàng = ${orderCode}`
    );
    // **Xác thực webhook với signature**
    const secret = process.env.PAYOS_API_SECRET; // Lấy khóa bí mật từ env
    const dataString = `orderCode=${orderCode}&status=${status}`; // Dữ liệu để tạo chữ ký
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(dataString)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.warn("⚠️ Cảnh báo: Webhook PayOS có chữ ký không hợp lệ!");
      return res.status(401).json({ error: "Invalid signature" });
    }

    console.log("✅ Webhook hợp lệ, tiến hành xử lý...");

    // **Xử lý thanh toán theo trạng thái**
    if (status === "COMPLETED") {
      console.log(`✅ Đơn hàng ${orderCode} đã thanh toán thành công.`);
      // TODO: Cập nhật database, gửi email xác nhận...
    } else if (status === "FAILED") {
      console.log(`❌ Đơn hàng ${orderCode} thanh toán thất bại.`);
    } else if (status === "CANCELLED") {
      console.log(`🚫 Đơn hàng ${orderCode} đã bị hủy.`);
    } else if (status === "PENDING") {
      console.log(`⏳ Đơn hàng ${orderCode} đang chờ xử lý.`);
    }

    return res.sendStatus(200); // Xác nhận với PayOS webhook đã được xử lý
  } catch (error) {
    console.error("❌ Lỗi khi xử lý webhook PayOS:", error);
    return res.sendStatus(500);
  }
});

const updateWebhookUrl = async () => {
  try {
    const response = await axios.post(
      "https://api-merchant.payos.vn/confirm-webhook",
      {
        webhookUrl: "http://localhost:3030/api/payos-webhook", // Thay bằng URL webhook của bạn
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-client-id": process.env.PAYOS_CLIENT_ID, // Client ID từ PayOS
          "x-api-key": process.env.PAYOS_API_KEY, // API Key từ PayOS
        },
      }
    );

    console.log("✅ Webhook URL đã được cập nhật:", response.data);
  } catch (error) {
    console.error(
      "❌ Lỗi khi cập nhật Webhook URL:",
      error.response?.data || error
    );
  }
};

// Gọi hàm để cập nhật Webhook URL
updateWebhookUrl();

// APIs
app.get("/", (req, res) => {
  res.send("Server is running");
});

// api send-otp post
app.post("/send-otp", async (req, res) => {
  const { firstName, lastName, password, confirmPassword, email, image } =
    req.body;

  try {
    const existingUser = await userModel.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered!" });
    }

    // Tạo OTP và thời gian hết hạn
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // Hết hạn sau 5 phút

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Your OTP for Signup Verification",
      text: `Your OTP is: ${otp}. It will expire in 5 minutes.\n\nThank you!`,
    };

    transporter.sendMail(mailOptions, async (err, info) => {
      if (err) {
        console.log(err);
        return res
          .status(500)
          .json({ message: "Failed to send OTP. Please try again." });
      }

      const newUser = new userModel({
        firstName,
        lastName,
        email,
        password,
        confirmPassword,
        image,
        otp,
        otpExpiresAt,
      });
      await newUser.save();

      res
        .status(200)
        .json({ message: "OTP sent to your email successfully!", alert: true });
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

//api verify-otp post
app.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;

  try {
    const user = await userModel.findOne({ email, otp });

    if (!user) {
      return res.status(400).json({ message: "Invalid OTP or email!" });
    }

    // Kiểm tra thời gian hết hạn OTP
    if (new Date() > user.otpExpiresAt) {
      await userModel.deleteOne({ _id: user._id });
      return res
        .status(400)
        .json({ message: "OTP has expired. Please request a new one." });
    }
    user.isVerified = true;
    // Xóa OTP sau khi xác thực thành công
    await userModel.updateOne(
      { email },
      {
        $set: { isVerified: true },
        $unset: { otp: "", otpExpiresAt: "" },
      }
    );
    res.status(200).json({ message: "OTP verified successfully!" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
});

//login api
app.post("/login", async (req, res) => {
  // console.log(req.body)
  try {
    const { email, password, isVerified } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .send({ message: "Email and password is required" });
    }

    const result = await userModel.findOne({ email });

    if (result) {
      if (result.isVerified) {
        if (password === result.password) {
          const dataSend = {
            _id: result._id,
            firstName: result.firstName,
            lastName: result.lastName,
            email: result.email,
            image: result.image,
          };
          console.log(dataSend);
          return res.status(200).send({
            message: "Login is successfully",
            alert: true,
            data: dataSend,
          });
        } else {
          return res.status(400).send({
            message: "Invalid password",
            alert: false,
          });
        }
      } else {
        return res
          .status(403)
          .json({ message: "Account not verified. Please verify your email." });
      }
    } else {
      return res.status(400).send({
        message: "Email is not available, please sign up",
        alert: false,
      });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).send({ message: "An error occurred during login" });
  }
});

// Product APIs
app.post("/uploadProduct", async (req, res) => {
  try {
    const data = new productModel(req.body);
    await data.save();
    res.status(200).send({ message: "Product uploaded successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to upload product" });
  }
});

app.get("/product", async (req, res) => {
  try {
    const data = await productModel.find({});
    res.status(200).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to fetch products" });
  }
});
app.post("/uploadProduct", async (req, res) => {
  console.log(req.body);
  const data = productModel(req.body);
  const datasave = await data.save();
  res.send({ message: "Upload successfully" });
});

app.get("/product/search", async (req, res) => {
  try {
    const { name } = req.query;

    if (!name || name.trim() === "") {
      console.log("Search term missing");
      return res.status(400).json({ error: "Search term is required" });
    }

    // Sử dụng regex để tìm kiếm sản phẩm theo tên
    const query = { name: { $regex: name, $options: "i" } }; // options: i => không phân biệt chữ hoa, chữ thường
    const data = await productModel.find(query);
    // console.log('Search Query:', query); // Log query để kiểm tra
    // console.log('Search Results:', data); // Log kết quả từ database
    res.status(200).json(data);
  } catch (error) {
    console.error("Error searching for products:", error);
    res.status(500).json({ error: "Failed to search for products" });
  }
});

// Discount APIs
app.post("/uploadDiscount", async (req, res) => {
  try {
    console.log("Received Discount Data:", req.body);

    const {
      code,
      type,
      value,
      startDate,
      endDate,

      timeFrame,
      minimumOrderValue,
      minimumItems,
      applicableCategories,
      usageLimit,
    } = req.body;

    if (
      !code ||
      !type ||
      !value ||
      !startDate ||
      !endDate ||
      !timeFrame.start ||
      !timeFrame.end ||
      !minimumOrderValue ||
      !minimumItems ||
      applicableCategories.length === 0 ||
      !usageLimit
    ) {
      return res.status(400).send({ message: "Missing required fields" });
    }

    const newDiscount = new discountModel(req.body);
    await newDiscount.save();
    res.status(200).send({ message: "Discount added successfully!" });
  } catch (err) {
    console.error("Error uploading discount:", err);
    res.status(500).send({ message: "Failed to add discount" });
  }
});

app.get("/discounts", async (req, res) => {
  try {
    const discounts = await discountModel.find({});
    res.status(200).json(discounts);
  } catch (err) {
    console.error("Error fetching discounts:", err);
    res.status(500).send({ message: "Failed to fetch discounts" });
  }
});

// Contact APIs
app.post("/submit-contact", async (req, res) => {
  try {
    const { name, email, phone, message } = req.body;

    if (!name || !email || !phone || !message) {
      return res.status(400).json({ message: "All fields are required." });
    }

    const newContact = new contactModel({ name, email, phone, message });
    await newContact.save();
    res.status(200).json({ message: "Form submitted successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error submitting the form." });
  }
});

app.get("/get-contacts", async (req, res) => {
  try {
    const contacts = await contactModel.find().sort({ createdAt: -1 });
    res.status(200).json(contacts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching contact data." });
  }
});

// API gửi OTP
app.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await userModel.findOne({ email });

    if (!user) {
      return res.status(404).json({
        message: "Email không tồn tại trong hệ thống",
        alert: false,
      });
    }

    // Tạo OTP 6 số
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const resetOtpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 phút

    // Lưu OTP vào database
    user.resetOtp = otp;
    user.resetOtpExpires = resetOtpExpires;
    await user.save();

    // Gửi email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Mã OTP đặt lại mật khẩu",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Mã OTP đặt lại mật khẩu của bạn</h2>
          <p>Mã OTP của bạn là: <strong>${otp}</strong></p>
          <p>Mã này sẽ hết hạn sau 5 phút.</p>
          <p>Nếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua email này.</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.json({
      message: "Mã OTP đã được gửi đến email của bạn",
      alert: true,
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({
      message: "Đã có lỗi xảy ra, vui lòng thử lại sau",
      alert: false,
    });
  }
});

// API đặt lại mật khẩu với OTP
app.post("/reset-password", async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    const user = await userModel.findOne({
      email,
      resetOtp: otp,
      resetOtpExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        message: "Mã OTP không hợp lệ hoặc đã hết hạn",
        alert: false,
      });
    }

    // Cập nhật mật khẩu và xóa OTP
    user.password = newPassword;
    user.confirmPassword = newPassword;
    user.resetOtp = undefined;
    user.resetOtpExpires = undefined;
    await user.save();

    res.json({
      message: "Đặt lại mật khẩu thành công",
      alert: true,
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({
      message: "Đã có lỗi xảy ra, vui lòng thử lại sau",
      alert: false,
    });
  }
});

// API để nhận dữ liệu form
app.post("/submit-contact", async (req, res) => {
  try {
    const { name, email, phone, message } = req.body;

    if (!name || !email || !phone || !message) {
      return res.status(400).json({ message: "All fields are required." });
    }

    // Lưu vào MongoDB
    const newContact = new contactModel({
      name,
      email,
      phone,
      message,
    });

    await newContact.save();

    res.status(200).json({ message: "Form submitted successfully!" });
  } catch (error) {
    console.error("Error saving contact form:", error);
    res.status(500).json({ message: "Error submitting the form." });
  }
});

// API để lấy danh sách đánh giá từ MongoDB
app.get("/get-contacts", async (req, res) => {
  try {
    const contacts = await contactModel.find().sort({ createdAt: -1 }); // Sắp xếp theo ngày tạo (mới nhất trước)
    res.status(200).json(contacts);
  } catch (error) {
    console.error("Error fetching contacts:", error);
    res.status(500).json({ message: "Error fetching contact data." });
  }
});

// Cập nhật thông tin khách hàng
const updateInfoSchema = mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  address: { type: String, required: true },
  dob: { type: Date, required: true },
});

// Tạo model từ schema
const updateInfoModel = mongoose.model("UpdateInfo", updateInfoSchema);

// API để nhận dữ liệu form cập nhật thông tin khách hàng
app.post("/update-customer-info", async (req, res) => {
  try {
    const { fullName, email, phone, address, dob } = req.body;

    // Kiểm tra dữ liệu có đủ không
    if (!fullName || !email || !phone || !address || !dob) {
      return res.status(400).json({ message: "All fields are required." });
    }

    // Cập nhật thông tin vào MongoDB
    const updatedInfo = await updateInfoModel.findOneAndUpdate(
      { email }, // Sử dụng _id để tìm khách hàng
      { fullName, phone, address, dob },
      { new: true } // Cập nhật thông tin và trả về đối tượng đã cập nhật
    );

    if (!updatedInfo) {
      return res.status(404).json({ message: "Customer not found." });
    }

    // Trả về phản hồi thành công
    res.status(200).json({ message: "Information updated successfully!" });
  } catch (error) {
    console.error("Error updating customer info:", error);
    res.status(500).json({ message: "Error updating the information." });
  }
});

// API để lấy tất cả thông tin khách hàng
app.get("/get-customer-info/:id", async (req, res) => {
  try {
    // Tìm khách hàng theo email
    const customer = await updateInfoModel.findOne({ email: req.params.email });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.status(200).json(customer);
  } catch (error) {
    console.error("Error fetching customer info:", error);
    res.status(500).json({ message: "Error fetching customer data." });
  }
});

//Gửi kết nối messages phản hồi với database
app.use("/", router);
app.listen(8080, () => console.log("Server is running at port : " + PORT));
