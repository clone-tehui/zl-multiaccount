import { callOpenRouter, routeModel } from './ai-automation-openrouter.js';
import { getAgentById, getToolForAgent, listToolsForAgent, loadAgentMemory, saveAgentMemory } from './agent-system-db.js';

const DEFAULT_SNOOZE_PRESETS_MINUTES = [5, 10, 20, 30, 60];
const DEFAULT_ESCALATION_KEYWORDS = [
  'khiếu nại',
  'complaint',
  'bực',
  'tức',
  'không hài lòng',
  'hoàn tiền',
  'refund',
  'huỷ phòng',
  'hủy phòng',
  'gặp quản lý',
  'gặp người thật',
  'nói chuyện với người',
  'khẩn cấp'
];
export const DEFAULT_AI_AUTOMATION_CONFIG = {
  enabled: false,
  mode: 'assistive',
  defaultThreadMode: 'off',
  allowedDepartments: [],
  selectedAccountIds: [],
  adminAlertUserIds: [],
  systemPrompt: 'Bạn là Orchestrator chính của hệ multi-agent CSKH ChiHome. Nhiệm vụ của bạn là đọc tin khách, hiểu bối cảnh, chọn đúng agent phụ/tool phù hợp, tổng hợp kết quả và trả lời khách như một tư vấn viên ChiHome cao cấp. Không gọi tất cả agent; chỉ gọi agent có liên quan trực tiếp. Không nói mình là AI, không nhắc model/tool/hệ thống nội bộ với khách. Quy tắc chọn agent: greeting/chào hỏi chỉ dùng composer; booking/tìm phòng/báo giá dùng booking_agent, nếu đủ ngày + số khách/phòng hoặc khách nói rõ số PN/số giường/loại căn thì thêm hotel_live_data và room_detail_agent, nếu cần bảng giá/link ảnh/knowledge thì thêm retrieval; policy/check-in/check-out dùng house_rules_agent + retrieval + policy_guard; tiện ích/dịch vụ lưu trú dùng guest_stay_agent + retrieval; dịch vụ vận hành/đưa đón/đậu xe/tour chỉ dùng company_ops_agent khi khách hỏi trực tiếp; complaint/hoàn tiền/khách bực/yêu cầu người thật dùng special_cases_agent + policy_guard và escalation. Với booking chỉ thu đúng 3 dữ kiện: check-in, check-out, số phòng ngủ hoặc số khách quy đổi; ngày tự nhiên như hôm kia/hôm qua/hôm nay/ngày mai/mai/mốt/ngày kia phải tự chuyển thành ngày thật theo timezone Việt Nam trước khi gọi API; đủ dữ kiện thì kiểm tra live ngay và gửi phương án phòng, không hỏi view/toà/ngân sách trước, không nói đang tìm/đang kiểm tra rồi báo lại. Khi có phòng, bắt buộc trả đúng format: Dạ em tìm được [N] căn phù hợp với thông tin mình đưa + nhắc lại ngày nhận/trả, số đêm, số khách/số PN; sau đó gửi lần lượt từng căn gồm tòa + mã căn, số PN, số WC, giá/đêm, tổng tiền theo số đêm và toàn bộ hình của căn đó. Không trả lời cụt. Không tự nhắc Grab, Green SM/Xanh SM, taxi, sân bay, đưa đón hoặc di chuyển nếu khách không hỏi. Luôn ưu tiên dữ liệu live ChiHomeHotel cho phòng trống/giá/tình trạng; không bịa dữ liệu.',
  replyStylePrompt: 'Trả lời bằng tiếng Việt tự nhiên, sang trọng vừa đủ, đi thẳng vào câu khách hỏi. Không dùng cụm máy móc như “dựa trên dữ liệu”, “tôi là AI”, “tôi không thể giúp”. Nếu khách chỉ chào hỏi lần đầu có thể dùng: “Dạ ChiHome xin chào, em có thể hỗ trợ gì cho mình ạ?” Với booking, khi thiếu dữ kiện chỉ hỏi đúng dữ kiện đó; khi đủ dữ kiện thì kiểm tra live ngay và trả kết quả đầy đủ theo từng căn, không rút gọn mất thông tin phòng/giá/hình.',
  humanHandoffPrompt: 'Tóm tắt ngắn case, nêu lý do escalation, thông tin còn thiếu, và đề xuất hành động cho admin.',
  flowDefinitions: [
    {
      id: 'booking_discovery',
      label: 'Tư vấn đặt phòng',
      enabled: true,
      intents: ['availability', 'quote', 'booking'],
      steps: ['classify_intent', 'collect_checkin_checkout_room_count', 'check_availability_live', 'lookup_room_detail_live', 'summarize_options']
    },
    {
      id: 'faq_room_service',
      label: 'FAQ phòng / dịch vụ',
      enabled: true,
      intents: ['room_info', 'amenities', 'service', 'policy'],
      steps: ['classify_intent', 'retrieve_knowledge', 'draft_answer', 'verify_answer']
    },
    {
      id: 'complaint_handoff',
      label: 'Complaint / escalation',
      enabled: true,
      intents: ['complaint', 'refund', 'urgent'],
      steps: ['detect_risk', 'pause_automation', 'alert_admin', 'handoff_summary']
    }
  ],
  promptLibrary: [
    {
      id: 'guest_greeting',
      label: 'Mở đầu hội thoại',
      prompt: 'Chào khách, xác nhận nhu cầu chính, và hỏi tối thiểu thông tin còn thiếu để tra cứu chính xác.'
    },
    {
      id: 'availability_compose',
      label: 'Compose availability',
      prompt: 'Booking flow chỉ thu 3 dữ kiện: check-in, check-out, số phòng ngủ/số khách quy đổi. Ngày tự nhiên như hôm kia/hôm qua/hôm nay/ngày mai/mai/mốt/ngày kia phải tự đổi thành ngày YYYY-MM-DD theo timezone Việt Nam trước khi gọi API. Đủ dữ kiện thì gọi tool nội bộ search_availability_live ngay; không hỏi view/toà/ngân sách trước. Khi có kết quả, trả đúng format: Dạ em tìm được [N] căn phù hợp với thông tin mình đưa… rồi mỗi căn: + Căn X: [Toà + mã căn], số PN, số WC, giá 1 đêm, tổng tiền theo số đêm, sau đó gửi toàn bộ hình của riêng căn đó.'
    },
    {
      id: 'complaint_acknowledge',
      label: 'Acknowledgement complaint',
      prompt: 'Không tranh cãi. Xác nhận đã tiếp nhận, xin lỗi ngắn gọn, không hứa điều vượt thẩm quyền, và chuyển người phụ trách.'
    }
  ],
  automationRules: [
    {
      id: 'auto_pause_on_complaint',
      enabled: true,
      when: { sentiment: 'negative', keywordGroup: 'complaintKeywords' },
      then: { action: 'escalate', mode: 'paused_by_escalation' }
    },
    {
      id: 'require_live_data_for_booking',
      enabled: true,
      when: { intentIn: ['availability', 'quote', 'booking'] },
      then: { action: 'require_knowledge_source', sourceId: 'chihomehotel_availability' }
    },
    {
      id: 'small_model_for_faq',
      enabled: true,
      when: { intentIn: ['greeting', 'general', 'faq'] },
      then: { action: 'prefer_model_tier', tier: 'small' }
    }
  ],
  agentRegistry: [
    {
      id: 'orchestrator',
      label: 'Orchestrator chính',
      enabled: true,
      role: 'planner',
      responsibilities: ['phân loại intent', 'chọn flow', 'giao việc cho specialist agents', 'ra quyết định escalation', 'giữ giọng tư vấn ChiHome cao cấp nhưng không giả danh hệ thống'],
      tools: ['route_to_booking_agent: dùng khi khách đặt phòng/tìm phòng/báo giá/availability', 'route_to_hotel_live_data: dùng khi booking đủ ngày + số khách/phòng để gọi dữ liệu live', 'route_to_room_detail_agent: dùng sau live search để chuẩn hoá từng căn/ảnh/giá/đặc điểm', 'route_to_retrieval: dùng khi cần knowledge, bảng giá, kịch bản CSKH hoặc link ảnh', 'route_to_house_rules_agent: dùng cho nội quy, check-in/check-out, policy căn hộ', 'route_to_guest_stay_agent: dùng cho khách đang lưu trú, tiện ích, sự cố trong căn', 'route_to_company_ops_agent: dùng cho đưa đón, đậu xe, thuê xe, tour, dịch vụ vận hành', 'route_to_special_cases_agent: dùng cho complaint, hoàn tiền, ngoại lệ, yêu cầu người thật', 'route_to_policy_guard: dùng để kiểm tra rủi ro/fact/policy khi case nhạy cảm'],
      modelTier: 'medium'
    },
    {
      id: 'retrieval',
      label: 'Retrieval agent',
      enabled: true,
      role: 'grounding',
      responsibilities: ['đọc knowledge base', 'rag search', 'gom facts'],
      tools: ['lookup_knowledge_xlsx: tra tài liệu/kịch bản CSKH/bảng giá/link ảnh khi câu hỏi cần fact nội bộ'],
      modelTier: 'small'
    },
    {
      id: 'hotel_live_data',
      label: 'Hotel live data agent',
      enabled: true,
      role: 'tool_user',
      responsibilities: ['gọi API ChiHomeHotel nội bộ để kiểm tra availability', 'chỉ query khi đủ check-in/check-out/số phòng ngủ hoặc số khách đã quy đổi', 'ngày tự nhiên phải được chuẩn hoá thành YYYY-MM-DD/checkindate/checkoutdate trước khi gọi API', 'trả dữ liệu live chính xác, không chào hỏi'],
      tools: ['search_availability_live: gọi API ChiHomeHotel để tìm phòng trống khi đủ check-in/check-out/số khách hoặc số phòng ngủ', 'lookup_room_catalog_live: lấy catalog/metadata phòng live để đối chiếu mã căn/toà/loại phòng'],
      modelTier: 'small'
    },
    {
      id: 'booking_agent',
      label: 'Booking / tìm phòng agent',
      enabled: true,
      role: 'booking_specialist',
      responsibilities: ['thu đúng 3 dữ kiện booking: checkindate, checkoutdate, sophongngu', 'tự đổi ngày tự nhiên: hôm kia=-2, hôm qua=-1, hôm nay=0, ngày mai/mai=+1, mốt/ngày kia=+2 theo timezone Việt Nam', 'quy đổi số khách sang số phòng ngủ: 1-2=1PN, 3-4=2PN, 5-6=3PN, 7-8=4PN, số lẻ lấy căn lớn hơn', 'khi đủ dữ kiện thì yêu cầu hotel_live_data gọi search_availability_live ngay, không hỏi view/toà/ngân sách trước', 'nếu thiếu dữ kiện chỉ hỏi đúng phần còn thiếu'],
      tools: ['extract_booking_requirements: bóc check-in/check-out/số khách/số phòng ngủ từ tin khách', 'convert_guests_to_bedrooms: quy đổi số khách sang số phòng ngủ theo rule ChiHome', 'request_live_availability: yêu cầu hotel_live_data kiểm tra live khi đủ dữ kiện', 'compose_booking_options: chuẩn bị phương án phòng để composer trả khách'],
      modelTier: 'small'
    },
    {
      id: 'room_detail_agent',
      label: 'Room detail / data processor agent',
      enabled: true,
      role: 'data_processor',
      responsibilities: ['nhận danh sách căn từ availability live', 'chuẩn hoá chi tiết từng căn: toà, mã căn, số phòng ngủ, số WC, giá 1 đêm, tổng tiền theo số đêm, toàn bộ hình ảnh theo đúng căn', 'trả dữ liệu thô đã format cho agent chính, không chào hỏi, không rút gọn thành summary và không tự bịa thông tin'],
      tools: ['lookup_room_catalog_live: lấy chi tiết từng căn từ dữ liệu live/catalog', 'format_room_options: chuẩn hoá mỗi căn gồm toà, mã căn, diện tích, giá, đặc điểm, toàn bộ link ảnh theo căn'],
      modelTier: 'small'
    },
    {
      id: 'house_rules_agent',
      label: 'Nội quy / tiện ích căn hộ agent',
      enabled: true,
      role: 'policy_specialist',
      responsibilities: ['trả lời nội quy căn hộ', 'wifi/thẻ/hút thuốc/toilet/máy nước nóng/rác', 'hồ bơi/gym/phụ phí'],
      tools: ['lookup_chihome_cskh_scripts: tra kịch bản CSKH cho nội quy/policy/check-in/check-out', 'review_policy_risk: kiểm tra câu trả lời có vượt chính sách không'],
      modelTier: 'small'
    },
    {
      id: 'guest_stay_agent',
      label: 'Hỗ trợ khách đang lưu trú agent',
      enabled: true,
      role: 'stay_support',
      responsibilities: ['check-in/check-out', 'khách chờ nhân viên đón', 'dọn phòng/giặt ủi/vật dụng trong căn', 'sự cố ở hiện tại'],
      tools: ['lookup_chihome_cskh_scripts: tra kịch bản hỗ trợ khách đang lưu trú', 'handoff_if_needed: đề xuất chuyển người xử lý khi sự cố cần nhân viên thật'],
      modelTier: 'small'
    },
    {
      id: 'company_ops_agent',
      label: 'Vận hành / dịch vụ công ty agent',
      enabled: true,
      role: 'ops_specialist',
      responsibilities: ['dịch vụ đưa đón sân bay', 'phí đậu xe', 'thuê xe máy/tour/chợ/đổi tiền', 'giải thích quy trình vận hành ChiHome'],
      tools: ['lookup_chihome_cskh_scripts: tra script CSKH liên quan vận hành', 'lookup_company_services: tra dịch vụ đưa đón/đậu xe/thuê xe/tour/đổi tiền/chợ'],
      modelTier: 'small'
    },
    {
      id: 'special_cases_agent',
      label: 'Trường hợp đặc biệt / escalation agent',
      enabled: true,
      role: 'risk_specialist',
      responsibilities: ['complaint', 'khách yêu cầu ngoại lệ', 'huỷ/đổi lịch/trả phòng muộn', 'case cần hỏi quản lý'],
      tools: ['lookup_chihome_cskh_scripts: tra script cho trường hợp đặc biệt', 'review_policy_risk: đánh giá rủi ro/chính sách trước khi trả lời', 'handoff_summary: tóm tắt cho người phụ trách khi cần escalation'],
      modelTier: 'medium'
    },
    {
      id: 'policy_guard',
      label: 'Policy / QA agent',
      enabled: true,
      role: 'verifier',
      responsibilities: ['soát sai fact', 'soát tone', 'kiểm tra policy'],
      tools: ['lookup_knowledge_xlsx: đối chiếu fact nội bộ trước khi duyệt', 'review_policy_risk: soát sai fact, tone, policy, rủi ro hứa quá thẩm quyền'],
      modelTier: 'medium'
    },
    {
      id: 'composer',
      label: 'Reply composer',
      enabled: true,
      role: 'writer',
      responsibilities: ['soạn câu trả lời cuối', 'giữ giọng điệu', 'đưa CTA rõ ràng'],
      tools: ['compose_from_tool_outputs: chỉ viết câu trả lời cuối dựa trên kết quả agent/tool đã có, không tự bịa fact mới'],
      modelTier: 'medium'
    }
  ],
  delegationRules: [
    {
      id: 'booking_needs_live_data',
      label: 'Booking phải gọi live data',
      enabled: true,
      when: { intentIn: ['availability', 'quote', 'booking', 'pricing', 'room_info', 'building_info'] },
      handoff: ['booking_agent', 'hotel_live_data', 'room_detail_agent']
    },
    {
      id: 'house_rules_and_guest_stay_scripts',
      label: 'Nội quy / lưu trú dùng kịch bản CSKH',
      enabled: true,
      when: { intentIn: ['policy', 'checkin', 'checkout', 'amenities', 'service', 'general', 'greeting'] },
      handoff: ['house_rules_agent', 'guest_stay_agent']
    },
    {
      id: 'complaint_needs_guard',
      label: 'Complaint phải có QA agent',
      enabled: true,
      when: { intentIn: ['complaint', 'refund', 'urgent'] },
      handoff: ['special_cases_agent', 'policy_guard']
    }
  ],
  modelCatalog: [
    {
      id: 'deepseek_v4_flash',
      modelId: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      provider: 'openrouter',
      kind: 'chat',
      tier: 'small',
      promptPricePer1M: 0.112,
      completionPricePer1M: 0.224,
      contextLength: 1048576,
      strengths: ['rất rẻ', 'context lớn', 'tool calling / structured outputs', 'phù hợp classify/router/retrieval passes'],
      weaknesses: ['không phải lựa chọn an toàn nhất cho case quá nhạy cảm', 'chất lượng wording cuối có thể cần model mạnh hơn để polish'],
      useCases: ['classify_intent', 'light_routing', 'retrieval_planning', 'faq_simple', 'draft_internal_summary'],
      recommendedFor: ['router nhỏ', 'nhiệm vụ nền số lượng lớn', 'bước suy luận phụ giá rẻ'],
      verifiedSource: 'OpenRouter model API'
    },
    {
      id: 'google_gemini_35_flash',
      modelId: 'google/gemini-3.5-flash',
      label: 'Google Gemini 3.5 Flash',
      provider: 'openrouter',
      kind: 'chat',
      tier: 'medium',
      promptPricePer1M: 1.5,
      completionPricePer1M: 9,
      contextLength: 1048576,
      modality: 'text+image+file+audio+video',
      strengths: ['đa phương thức mạnh', 'agentic execution tốt', 'hợp file/image/audio', 'hợp các lượt compose cần hiểu ngữ cảnh lớn'],
      weaknesses: ['đắt hơn DeepSeek khá nhiều', 'không nên dùng mặc định cho mọi lượt vì tốn cost'],
      useCases: ['compose_structured', 'file_grounding', 'multimodal_guest_request', 'verification_with_attachments'],
      recommendedFor: ['khách gửi ảnh/file', 'cần đọc tài liệu dài', 'orchestrator trung tâm cho ca vừa'],
      verifiedSource: 'OpenRouter model API'
    },
    {
      id: 'deepseek_v4_pro',
      modelId: 'deepseek/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      provider: 'openrouter',
      kind: 'chat',
      tier: 'medium',
      promptPricePer1M: 0.435,
      completionPricePer1M: 0.87,
      contextLength: 1048576,
      strengths: ['reasoning text-only mạnh hơn flash', 'rẻ hơn rất nhiều so với frontier premium', 'context rất lớn'],
      weaknesses: ['không multimodal như Gemini 3.5 Flash', 'không nên là lựa chọn duy nhất cho case cần wording/guardrails cao cấp nhất'],
      useCases: ['policy_lookup', 'quote_reasoning', 'complex_text_reasoning', 'verifier_text_only'],
      recommendedFor: ['ca phức tạp nhưng chủ yếu text', 'verifier trung cấp', 'tool orchestration giá hợp lý'],
      verifiedSource: 'OpenRouter model API'
    },
    {
      id: 'openai_gpt_55',
      modelId: 'openai/gpt-5.5',
      label: 'OpenAI GPT-5.5',
      provider: 'openrouter',
      kind: 'chat',
      tier: 'large',
      promptPricePer1M: 5,
      completionPricePer1M: 30,
      contextLength: 1050000,
      modality: 'text+image+file',
      strengths: ['frontier reasoning mạnh', 'độ tin cậy cao cho case khó', 'phù hợp final review / complaint / escalations'],
      weaknesses: ['rất đắt', 'không phù hợp làm default cho lượt chat thường'],
      useCases: ['complaint', 'final_review', 'high_stakes_handoff', 'complex_multistep'],
      recommendedFor: ['case rủi ro cao', 'VIP', 'complaint nhạy cảm', 'review cuối trước khi gửi khách'],
      verifiedSource: 'OpenRouter model API'
    }
  ],
  embeddingCatalog: [
    {
      id: 'openai_text_embedding_3_large',
      modelId: 'openai/text-embedding-3-large',
      label: 'OpenAI text-embedding-3-large',
      provider: 'openrouter',
      dimensions: 3072,
      supportedDimensions: [3072, 1536],
      maxInputTokens: 8192,
      promptPricePer1M: 0.13,
      strengths: ['embedding chất lượng cao', 'mạnh cho retrieval precision', 'phù hợp knowledge base nhỏ-vừa cần độ chính xác cao'],
      weaknesses: ['vector nặng hơn, tốn storage hơn bản rút gọn'],
      verifiedSource: 'OpenAI embeddings docs + OpenRouter endpoints',
      status: 'ready_template'
    },
    {
      id: 'google_gemini_embedding_001',
      modelId: 'google/gemini-embedding-001',
      label: 'Google Gemini Embedding 001',
      provider: 'openrouter',
      dimensions: 3072,
      supportedDimensions: [768, 1536, 3072],
      maxInputTokens: 20000,
      promptPricePer1M: 0.15,
      strengths: ['context input dài hơn', 'linh hoạt truncate dimension', 'hợp dữ liệu lớn / nhiều tài liệu bảng'],
      weaknesses: ['nếu truncate dưới 3072 thì với model 001 cần chú ý normalize thủ công theo docs Google'],
      verifiedSource: 'Google embeddings docs + OpenRouter endpoints',
      status: 'ready_template'
    }
  ],
  vectorStores: [
    {
      id: 'default_rag_store',
      label: 'Kho tri thức mặc định',
      enabled: true,
      backend: 'pgvector',
      collection: 'zlsever_ai_knowledge',
      embeddingModelId: 'google_gemini_embedding_001',
      dimensions: 1536,
      distanceMetric: 'cosine',
      normalizationRequired: true,
      status: 'planned'
    }
  ],
  knowledgeDocuments: [
    {
      id: 'knowledge_chihome_kich_ban_cskh',
      name: 'Kịch bản CSKH ChiHome',
      enabled: true,
      type: 'markdown',
      path: 'data/ai-knowledge/chihome-cskh-kich-ban.md',
      tags: ['chihome', 'cskh', 'house_rules', 'guest_stay', 'company_ops']
    }
  ],
  modelRouter: {
    classify: 'small',
    retrieve: 'small',
    composeSimple: 'small',
    composeStructured: 'medium',
    complaint: 'large',
    fallback: 'small'
  },
  providerRouting: {
    primary: 'openrouter',
    fallback: 'openrouter'
  },
  orchestration: {
    maxAutoTurns: 4,
    maxToolCallsPerTurn: 3,
    enableDraftReview: false,
    autoDisableOnEscalation: true,
    humanHandoffMode: 'pause_and_alert'
  },
  escalation: {
    complaintKeywords: DEFAULT_ESCALATION_KEYWORDS,
    directHumanRequest: true,
    negativeSentiment: true,
    repeatQuestionThreshold: 2,
    lowConfidenceThreshold: 0.72,
    complexIntentThreshold: 0.82,
    pauseThreadOnEscalation: true
  },
  knowledgeSources: [
    {
      id: 'chihomehotel_availability',
      enabled: true,
      type: 'api',
      label: 'ChiHomeHotel availability',
      intents: ['availability', 'quote', 'booking'],
      priority: 100
    },
    {
      id: 'chihomehotel_room_catalog',
      enabled: true,
      type: 'api',
      label: 'ChiHomeHotel room catalog',
      intents: ['room_info', 'amenities', 'building_info', 'pricing'],
      priority: 90
    },
    {
      id: 'internal_docs',
      enabled: true,
      type: 'rag',
      label: 'Tài liệu nội bộ',
      intents: ['policy', 'faq', 'checkin', 'checkout', 'service', 'general'],
      priority: 70
    },
    {
      id: 'script_library',
      enabled: true,
      type: 'flow',
      label: 'Kịch bản CSKH',
      intents: ['lead_capture', 'greeting', 'upsell', 'followup'],
      priority: 60
    }
  ],
  threadControls: {
    snoozePresetsMinutes: DEFAULT_SNOOZE_PRESETS_MINUTES,
    allowCustomSnoozeHours: true,
    defaultResumeNote: 'Tự mở lại auto reply sau thời gian tạm dừng.'
  }
};

export function normalizeAiAutomationConfig(input = {}, previous = DEFAULT_AI_AUTOMATION_CONFIG) {
  const merged = deepMerge(structuredClone(DEFAULT_AI_AUTOMATION_CONFIG), previous || {});
  const next = deepMerge(merged, input || {});
  next.enabled = Boolean(next.enabled);
  next.mode = oneOf(next.mode, ['off', 'assistive', 'autonomous'], 'assistive');
  next.defaultThreadMode = oneOf(next.defaultThreadMode, ['off', 'auto', 'snoozed', 'human_only'], 'off');
  next.allowedDepartments = uniqStrings(next.allowedDepartments);
  next.selectedAccountIds = uniqStrings(next.selectedAccountIds);
  next.adminAlertUserIds = uniqStrings(next.adminAlertUserIds);
  next.systemPrompt = String(next.systemPrompt || '').trim();
  next.replyStylePrompt = String(next.replyStylePrompt || '').trim();
  next.humanHandoffPrompt = String(next.humanHandoffPrompt || '').trim();
  next.flowDefinitions = normalizeOpenConfigArray(next.flowDefinitions);
  next.promptLibrary = normalizeOpenConfigArray(next.promptLibrary);
  next.automationRules = normalizeOpenConfigArray(next.automationRules);
  next.agentRegistry = normalizeOpenConfigArray(next.agentRegistry);
  next.delegationRules = normalizeOpenConfigArray(next.delegationRules);
  next.modelCatalog = normalizeOpenConfigArray(next.modelCatalog);
  next.embeddingCatalog = normalizeOpenConfigArray(next.embeddingCatalog);
  next.vectorStores = normalizeOpenConfigArray(next.vectorStores);
  next.knowledgeDocuments = normalizeOpenConfigArray(next.knowledgeDocuments);
  next.orchestration.maxAutoTurns = clampInt(next.orchestration?.maxAutoTurns, 1, 12, 4);
  next.orchestration.maxToolCallsPerTurn = clampInt(next.orchestration?.maxToolCallsPerTurn, 1, 10, 3);
  next.orchestration.enableDraftReview = Boolean(next.orchestration?.enableDraftReview);
  next.orchestration.autoDisableOnEscalation = Boolean(next.orchestration?.autoDisableOnEscalation);
  next.orchestration.humanHandoffMode = oneOf(next.orchestration?.humanHandoffMode, ['pause_and_alert', 'alert_only', 'queue_only'], 'pause_and_alert');
  next.escalation.complaintKeywords = uniqStrings(next.escalation?.complaintKeywords?.length ? next.escalation.complaintKeywords : DEFAULT_ESCALATION_KEYWORDS);
  next.escalation.directHumanRequest = Boolean(next.escalation?.directHumanRequest);
  next.escalation.negativeSentiment = Boolean(next.escalation?.negativeSentiment);
  next.escalation.repeatQuestionThreshold = clampInt(next.escalation?.repeatQuestionThreshold, 1, 10, 2);
  next.escalation.lowConfidenceThreshold = clampNumber(next.escalation?.lowConfidenceThreshold, 0.2, 1, 0.72);
  next.escalation.complexIntentThreshold = clampNumber(next.escalation?.complexIntentThreshold, 0.2, 1, 0.82);
  next.escalation.pauseThreadOnEscalation = Boolean(next.escalation?.pauseThreadOnEscalation);
  next.threadControls.snoozePresetsMinutes = normalizeSnoozePresets(next.threadControls?.snoozePresetsMinutes);
  next.threadControls.allowCustomSnoozeHours = Boolean(next.threadControls?.allowCustomSnoozeHours);
  next.threadControls.defaultResumeNote = String(next.threadControls?.defaultResumeNote || DEFAULT_AI_AUTOMATION_CONFIG.threadControls.defaultResumeNote).trim();
  next.knowledgeSources = normalizeKnowledgeSources(Array.isArray(next.knowledgeSources) && next.knowledgeSources.length
    ? next.knowledgeSources
    : DEFAULT_AI_AUTOMATION_CONFIG.knowledgeSources);
  next.modelRouter = normalizeModelRouter(next.modelRouter);
  next.providerRouting = {
    primary: String(next.providerRouting?.primary || 'openrouter').trim() || 'openrouter',
    fallback: String(next.providerRouting?.fallback || 'openrouter').trim() || 'openrouter'
  };
  return next;
}

export function normalizeAiAutomationDepartmentMap(input = {}, fallbackConfig = DEFAULT_AI_AUTOMATION_CONFIG) {
  const base = normalizeAiAutomationConfig(fallbackConfig || DEFAULT_AI_AUTOMATION_CONFIG);
  return Object.fromEntries(Object.entries(input || {})
    .map(([key, value]) => [String(key || '').trim(), normalizeAiAutomationConfig(value || {}, base)])
    .filter(([key]) => key));
}

export function resolveAiAutomationConfigForDepartment({ aiAutomation = DEFAULT_AI_AUTOMATION_CONFIG, aiAutomationByDepartment = {}, departmentId = null } = {}) {
  const normalizedFallback = normalizeAiAutomationConfig(aiAutomation || {});
  const normalizedMap = normalizeAiAutomationDepartmentMap(aiAutomationByDepartment, normalizedFallback);
  const key = String(departmentId || '').trim();
  return key && normalizedMap[key]
    ? normalizeAiAutomationConfig(normalizedMap[key], normalizedFallback)
    : normalizedFallback;
}

export function normalizeThreadAutomationState(input = {}, config = DEFAULT_AI_AUTOMATION_CONFIG, now = Date.now()) {
  const normalizedConfig = normalizeAiAutomationConfig(config);
  const resumeAt = normalizeDateTime(input.resumeAt);
  const snoozed = resumeAt ? Date.parse(resumeAt) > Number(now) : false;
  const mode = oneOf(input.mode, ['off', 'auto', 'snoozed', 'human_only', 'paused_by_escalation'], normalizedConfig.defaultThreadMode);
  const effectiveMode = snoozed && mode !== 'off' ? 'snoozed' : mode;
  return {
    mode: effectiveMode,
    enabled: effectiveMode === 'auto',
    resumeAt: snoozed ? resumeAt : null,
    mutedUntil: snoozed ? resumeAt : null,
    reason: String(input.reason || '').trim() || null,
    updatedAt: normalizeDateTime(input.updatedAt) || new Date(now).toISOString(),
    updatedBy: String(input.updatedBy || '').trim() || null,
    lastDecision: input.lastDecision && typeof input.lastDecision === 'object' ? sanitizeLastDecision(input.lastDecision) : null,
    lastEscalatedAt: normalizeDateTime(input.lastEscalatedAt),
    escalationCount: clampInt(input.escalationCount, 0, 9999, 0),
    assignedFlowId: String(input.assignedFlowId || '').trim() || null,
    policyId: String(input.policyId || '').trim() || null,
    conversationMemory: input.conversationMemory && typeof input.conversationMemory === 'object' ? sanitizeConversationMemory(input.conversationMemory) : null,
    agentMemories: input.agentMemories && typeof input.agentMemories === 'object' ? sanitizeAgentMemories(input.agentMemories) : {},
    memoryRows: sanitizeMemoryRows(input.memoryRows || []),
    memoryClearedAt: normalizeDateTime(input.memoryClearedAt) || null,
    messageTraces: input.messageTraces && typeof input.messageTraces === 'object' ? sanitizeMessageTraces(input.messageTraces) : {}
  };
}

export function patchThreadAutomationState(current = {}, patch = {}, config = DEFAULT_AI_AUTOMATION_CONFIG, now = Date.now()) {
  const base = normalizeThreadAutomationState(current, config, now);
  const next = {
    ...base,
    ...patch,
    updatedAt: new Date(now).toISOString()
  };
  return normalizeThreadAutomationState(next, config, now);
}

export function buildAgentPlan({
  message = {},
  thread = {},
  portalBinding = null,
  config = DEFAULT_AI_AUTOMATION_CONFIG,
  intent = 'general',
  confidence = 0.5,
  complexity = 'simple',
  asksHuman = false,
  repeatedQuestions = 0,
  sentiment = 'neutral',
  now = Date.now()
} = {}) {
  const normalizedConfig = normalizeAiAutomationConfig(config);
  const automation = normalizeThreadAutomationState(thread.automation || {}, normalizedConfig, now);
  if (!normalizedConfig.enabled || automation.mode === 'off' || automation.mode === 'human_only' || automation.mode === 'snoozed' || automation.mode === 'paused_by_escalation') {
    return {
      action: 'skip',
      reason: automation.mode === 'off' ? 'thread-disabled' : `thread-${automation.mode}`,
      automation,
      shouldReply: false,
      shouldAlert: false
    };
  }

  const escalation = detectEscalationTriggers({
    text: message.text || '',
    asksHuman,
    sentiment,
    repeatedQuestions,
    confidence,
    intent,
    complexity,
    config: normalizedConfig
  });

  if (escalation.shouldEscalate) {
    return {
      action: 'escalate',
      reason: escalation.reason,
      automation,
      shouldReply: false,
      shouldAlert: true,
      modelTier: 'large',
      knowledgeSources: [],
      escalation
    };
  }

  const knowledgeSources = pickKnowledgeSources({
    intent,
    departmentId: portalBinding?.departmentId || null,
    channelId: portalBinding?.channelId || null,
    config: normalizedConfig
  });

  const executionSignals = buildExecutionSignals({
    message,
    thread,
    intent,
    complexity,
    confidence,
    sentiment,
    repeatedQuestions,
    knowledgeSources,
    escalation,
    portalBinding
  });
  const modelTier = selectModelTier(executionSignals, normalizedConfig);
  const delegationPlan = buildDelegationPlan({ intent, complexity, knowledgeSources, config: normalizedConfig, signal: executionSignals });
  const specialistAgents = buildSpecialistAgents({
    intent,
    complexity,
    knowledgeSources,
    modelTier,
    config: normalizedConfig,
    signal: executionSignals,
    delegationPlan
  });

  return {
    action: 'reply',
    reason: 'auto-reply-eligible',
    automation,
    shouldReply: true,
    shouldAlert: false,
    modelTier,
    knowledgeSources,
    executionSignals,
    budget: buildTokenBudget(modelTier, complexity),
    specialistAgents,
    modelAssignments: specialistAgents.map((item) => ({
      agentId: item.id,
      modelId: item.modelId || null,
      tier: item.modelTier || null,
      reason: item.modelReason || null
    })),
    delegationPlan
  };
}

export function detectEscalationTriggers({
  text = '',
  asksHuman = false,
  sentiment = 'neutral',
  repeatedQuestions = 0,
  confidence = 0.5,
  intent = 'general',
  complexity = 'simple',
  config = DEFAULT_AI_AUTOMATION_CONFIG
} = {}) {
  const normalizedConfig = normalizeAiAutomationConfig(config);
  const haystack = String(text || '').toLowerCase();
  const keywordHit = normalizedConfig.escalation.complaintKeywords.find((item) => haystack.includes(String(item).toLowerCase()));
  if (asksHuman && normalizedConfig.escalation.directHumanRequest) {
    return { shouldEscalate: true, reason: 'human-requested', keyword: null };
  }
  if (keywordHit) {
    return { shouldEscalate: true, reason: 'complaint-keyword', keyword: keywordHit };
  }
  if (normalizedConfig.escalation.negativeSentiment && String(sentiment) === 'negative' && confidence < normalizedConfig.escalation.complexIntentThreshold) {
    return { shouldEscalate: true, reason: 'negative-sentiment-low-confidence', keyword: null };
  }
  if (repeatedQuestions >= normalizedConfig.escalation.repeatQuestionThreshold && isRepeatedQuestionEscalationSignal(text, repeatedQuestions)) {
    return { shouldEscalate: true, reason: 'repeated-questions', keyword: null };
  }
  if (confidence < normalizedConfig.escalation.lowConfidenceThreshold && (complexity === 'complex' || intent === 'complaint')) {
    return { shouldEscalate: true, reason: 'low-confidence-complex', keyword: null };
  }
  return { shouldEscalate: false, reason: null, keyword: null };
}

export function pickKnowledgeSources({ intent = 'general', config = DEFAULT_AI_AUTOMATION_CONFIG } = {}) {
  const normalizedConfig = normalizeAiAutomationConfig(config);
  return (normalizedConfig.knowledgeSources || [])
    .filter((item) => item.enabled !== false)
    .filter((item) => !item.intents?.length || item.intents.includes(intent) || item.intents.includes('general'))
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
}

export function selectModelTier(signal = {}, config = DEFAULT_AI_AUTOMATION_CONFIG) {
  const normalizedConfig = normalizeAiAutomationConfig(config);
  const complexity = String(signal.complexity || 'simple');
  const intent = String(signal.intent || 'general');
  const confidence = Number(signal.confidence ?? 0.5);
  const hasLiveToolData = Boolean(signal.hasLiveToolData);
  const sentiment = String(signal.sentiment || 'neutral');
  const hasAttachments = Boolean(signal.hasAttachments);
  const textLength = Number(signal.textLength || 0);
  const repeatedQuestions = Number(signal.repeatedQuestions || 0);
  const highRisk = Boolean(signal.highRisk);
  if (highRisk || intent === 'complaint' || (sentiment === 'negative' && confidence < 0.82)) return normalizedConfig.modelRouter.complaint;
  if (hasAttachments && (intent === 'availability' || intent === 'policy' || intent === 'service')) return normalizedConfig.modelRouter.composeStructured;
  if (complexity === 'complex') return normalizedConfig.modelRouter.composeStructured;
  if (complexity === 'structured' && (textLength > 500 || repeatedQuestions > 0)) return normalizedConfig.modelRouter.composeStructured;
  if (confidence < 0.65) return normalizedConfig.modelRouter.fallback;
  if (complexity === 'simple' && textLength < 280 && confidence >= 0.75) return normalizedConfig.modelRouter.classify;
  if (complexity === 'simple' && hasLiveToolData && !hasAttachments) return normalizedConfig.modelRouter.composeSimple;
  if (complexity === 'simple' && !hasAttachments && textLength < 700 && repeatedQuestions === 0) return normalizedConfig.modelRouter.composeSimple;
  return normalizedConfig.modelRouter.composeStructured;
}

export function buildSpecialistAgents({ intent = 'general', complexity = 'simple', knowledgeSources = [], modelTier = 'small', config = DEFAULT_AI_AUTOMATION_CONFIG, signal = {}, delegationPlan = null } = {}) {
  const normalizedConfig = normalizeAiAutomationConfig(config);
  const registry = new Map((normalizedConfig.agentRegistry || []).filter((item) => item.enabled !== false).map((item) => [item.id, item]));
  const effectiveDelegation = delegationPlan || buildDelegationPlan({ intent, complexity, knowledgeSources, config: normalizedConfig, signal });
  const requestedIds = new Set(['orchestrator', ...effectiveDelegation.agentIds, 'composer']);
  return [...requestedIds].filter((id) => registry.has(id) || id === 'orchestrator' || id === 'composer').map((id) => {
    const registered = registry.get(id);
    const preferredTier = id === 'composer'
      ? modelTier
      : inferAgentTier(id, signal, registered?.modelTier || modelTier);
    const assignment = resolveAgentModelAssignment({
      agentId: id,
      intent,
      knowledgeSources,
      preferredTier,
      signal,
      config: normalizedConfig
    });
    return {
      id,
      label: registered?.label || id,
      role: registered?.role || null,
      responsibilities: registered?.responsibilities || [],
      modelTier: assignment.tier || preferredTier,
      modelId: assignment.modelId || null,
      modelLabel: assignment.label || null,
      modelReason: assignment.reason || null,
      sources: id === 'retrieval' ? knowledgeSources.map((item) => item.id) : undefined,
      delegatedBy: id === 'orchestrator' ? null : 'orchestrator'
    };
  });
}

export function buildDelegationPlan({ intent = 'general', complexity = 'simple', knowledgeSources = [], config = DEFAULT_AI_AUTOMATION_CONFIG, signal = {} } = {}) {
  const normalizedConfig = normalizeAiAutomationConfig(config);
  const normalizedIntent = String(intent || 'general');
  const matchedRules = (normalizedConfig.delegationRules || []).filter((rule) => {
    const intents = Array.isArray(rule?.when?.intentIn) ? rule.when.intentIn : [];
    return rule?.enabled !== false && (!intents.length || intents.includes(normalizedIntent));
  });
  const agentIds = selectRelevantAgentIdsForSituation({ intent: normalizedIntent, complexity, knowledgeSources, signal });
  return {
    matchedRuleIds: matchedRules.map((item) => item.id),
    agentIds
  };
}

function selectRelevantAgentIdsForSituation({ intent = 'general', complexity = 'simple', knowledgeSources = [], signal = {} } = {}) {
  const agentIds = [];
  const add = (id) => {
    const value = String(id || '').trim();
    if (value && !agentIds.includes(value) && value !== 'orchestrator' && value !== 'composer') agentIds.push(value);
  };
  const hasKnowledge = Array.isArray(knowledgeSources) && knowledgeSources.length > 0;
  const hasAvailabilityApiKnowledge = knowledgeSources.some((item) => item?.id === 'chihomehotel_availability');
  const hasRoomCatalogApiKnowledge = knowledgeSources.some((item) => item?.id === 'chihomehotel_room_catalog');
  const liveSearchIntent = ['availability', 'quote', 'booking'].includes(intent)
    || (intent === 'pricing' && signal.bookingReady)
    || (intent === 'room_info' && signal.bookingReady);

  if (liveSearchIntent) {
    add('booking_agent');
    if (hasKnowledge && (intent === 'pricing' || intent === 'quote' || signal.hasKnowledgeRetrieval || knowledgeSources.some((item) => item?.type !== 'api'))) add('retrieval');
    if (signal.bookingReady || signal.hasLiveToolData || hasAvailabilityApiKnowledge) add('hotel_live_data');
    if (signal.bookingReady || signal.hasLiveToolData) add('room_detail_agent');
    if (intent === 'pricing' || complexity !== 'simple' || signal.highRisk) add('policy_guard');
    return agentIds;
  }

  if (intent === 'building_info') {
    if (hasKnowledge) add('retrieval');
    if (complexity !== 'simple' || signal.highRisk) add('policy_guard');
    return agentIds;
  }

  if (intent === 'room_info') {
    if (hasKnowledge || hasRoomCatalogApiKnowledge) add('retrieval');
    add('room_detail_agent');
    if (complexity !== 'simple' || signal.highRisk) add('policy_guard');
    return agentIds;
  }

  if (intent === 'pricing') {
    if (hasKnowledge) add('retrieval');
    add('policy_guard');
    return agentIds;
  }

  if (['policy', 'checkin', 'checkout'].includes(intent)) {
    add('house_rules_agent');
    if (hasKnowledge) add('retrieval');
    add('policy_guard');
    return agentIds;
  }

  if (['amenities', 'service'].includes(intent)) {
    add('guest_stay_agent');
    if (hasKnowledge) add('retrieval');
    if (complexity !== 'simple' || signal.hasAttachments) add('policy_guard');
    return agentIds;
  }

  if (['complaint', 'refund', 'urgent'].includes(intent) || signal.highRisk) {
    add('special_cases_agent');
    add('policy_guard');
    return agentIds;
  }

  if (signal.hasAttachments || signal.hasFileLikeInput || signal.hasImageLikeInput || signal.hasAudioLikeInput) {
    add('retrieval');
    add('policy_guard');
    return agentIds;
  }

  if (intent === 'greeting') return agentIds;

  if (intent === 'general') {
    if (complexity !== 'simple' || Number(signal.confidence || 0) < 0.75) add('retrieval');
    return agentIds;
  }

  if (hasKnowledge) add('retrieval');
  if (complexity !== 'simple') add('policy_guard');
  return agentIds;
}

export function buildTokenBudget(modelTier = 'small', complexity = 'simple') {
  const base = modelTier === 'large' ? 6000 : modelTier === 'medium' ? 3000 : 1200;
  const retrieval = complexity === 'simple' ? 900 : complexity === 'structured' ? 1500 : 2200;
  return {
    inputTokensSoft: base,
    retrievalTokensSoft: retrieval,
    outputTokensSoft: complexity === 'simple' ? 220 : 420,
    summarizationRequiredAfterTurns: complexity === 'simple' ? 8 : 4
  };
}

export function buildExecutionSignals({
  message = {},
  thread = {},
  intent = 'general',
  complexity = 'simple',
  confidence = 0.5,
  sentiment = 'neutral',
  repeatedQuestions = 0,
  knowledgeSources = [],
  escalation = null,
  portalBinding = null
} = {}) {
  const text = String(message?.text || '').trim();
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachmentTypes = attachments.map((item) => String(item?.contentType || item?.type || '').toLowerCase()).filter(Boolean);
  const hasAttachments = attachmentTypes.length > 0;
  const hasFileLikeInput = hasAttachments || Boolean(message?.fileUrl) || Boolean(message?.imageUrl);
  const hasImageLikeInput = attachmentTypes.some((item) => item.startsWith('image/'));
  const hasAudioLikeInput = attachmentTypes.some((item) => item.startsWith('audio/'));
  const normalizedText = normalizeSignalText(text);
  const bookingSlots = detectBookingInputSlots(normalizedText);
  const hiddenCustomerContext = buildHiddenCustomerContext(thread);
  const inputSituation = classifyInputSituation({ text, normalizedText, intent, complexity, confidence, hasAttachments, bookingSlots });
  const repeatedEscalation = isRepeatedQuestionEscalationSignal(text, repeatedQuestions);
  const highRisk = Boolean(escalation?.shouldEscalate)
    || intent === 'complaint'
    || (String(sentiment) === 'negative' && Number(confidence) < 0.82)
    || repeatedEscalation;
  return {
    intent: String(intent || 'general'),
    complexity: String(complexity || 'simple'),
    confidence: Number(confidence ?? 0.5),
    sentiment: String(sentiment || 'neutral'),
    repeatedQuestions: Number(repeatedQuestions || 0),
    repeatedEscalation,
    textLength: text.length,
    hasAttachments,
    hasFileLikeInput,
    hasImageLikeInput,
    hasAudioLikeInput,
    hasLiveToolData: knowledgeSources.some((item) => item.type === 'api'),
    hasKnowledgeRetrieval: knowledgeSources.some((item) => item.type === 'rag' || item.type === 'flow'),
    bookingSlots,
    bookingReady: Boolean(bookingSlots.hasDateRange && bookingSlots.hasOccupancy),
    missingBookingSlots: [bookingSlots.hasDateRange ? '' : 'date_range', bookingSlots.hasOccupancy ? '' : 'occupancy'].filter(Boolean),
    inputSituation,
    highRisk,
    hiddenCustomerContext,
    departmentId: portalBinding?.departmentId || null,
    channelId: portalBinding?.channelId || null
  };
}

export function buildHiddenCustomerContext(thread = {}) {
  const tags = uniqueStrings([
    ...(Array.isArray(thread?.tags) ? thread.tags : []),
    ...(Array.isArray(thread?.labels) ? thread.labels : [])
  ]).slice(0, 20);
  const normalizedTags = tags.map((tag) => normalizeSignalText(tag));
  const haystack = normalizedTags.join(' | ');
  let bookingState = 'unknown';
  const signals = [];
  if (/\b(huy|cancel|cancelled|canceled)\b/.test(haystack)) {
    bookingState = 'cancelled';
    signals.push('cancelled_tag');
  } else if (/\b(da\s*tra\s*phong|checked\s*out|checkout|check\s*out)\b/.test(haystack)) {
    bookingState = 'checked_out_or_past';
    signals.push('checkout_tag');
  } else if (/\b(da\s*in|da\s*check\s*in|checked\s*in|check\s*in|dang\s*o|in\s*house)\b/.test(haystack)) {
    bookingState = 'in_house_or_checked_in';
    signals.push('checkin_tag');
  } else if (/\b(da\s*dat\s*phong|dat\s*phong|booking|booked|reservation|confirmed|xac\s*nhan|da\s*coc|coc)\b/.test(haystack)) {
    bookingState = 'has_booking_or_reserved';
    signals.push('booking_tag');
  }
  const hasBookingHistory = bookingState !== 'unknown' || /\b(khach\s*hang|customer)\b/.test(haystack);
  const activeBooking = ['has_booking_or_reserved', 'in_house_or_checked_in'].includes(bookingState);
  return {
    tags,
    hasTags: tags.length > 0,
    hasBookingHistory,
    activeBooking,
    bookingState,
    signals
  };
}

function inferAgentTier(agentId, signal = {}, defaultTier = 'small') {
  const situation = String(signal.inputSituation || 'simple_text');
  if (agentId === 'orchestrator') {
    if (signal.highRisk || situation === 'ambiguous_or_low_confidence' || signal.hasFileLikeInput) return 'medium';
    return 'small';
  }
  if (agentId === 'booking_agent') {
    if (signal.bookingReady || signal.missingBookingSlots?.length) return 'small';
    return signal.confidence < 0.7 ? 'medium' : 'small';
  }
  if (agentId === 'hotel_live_data' || agentId === 'room_detail_agent' || agentId === 'retrieval') return 'small';
  if (agentId === 'policy_guard') return signal.highRisk ? 'large' : (situation === 'ambiguous_or_low_confidence' ? 'medium' : 'small');
  if (agentId === 'composer') {
    if (signal.highRisk || signal.hasFileLikeInput || situation === 'long_structured_request') return 'medium';
    if (signal.hasLiveToolData && signal.bookingReady && signal.confidence >= 0.85) return 'small';
    return defaultTier || 'medium';
  }
  return defaultTier || 'small';
}

function isRepeatedQuestionEscalationSignal(text = '', repeatedQuestions = 0) {
  const value = String(text || '').trim();
  if (Number(repeatedQuestions || 0) < 2) return false;
  if (value.length < 18) return false;
  const normalized = normalizeSignalText(value);
  if (/^(alo|hi|hello|xin chao|chao|ad oi|shop oi|ben minh oi)[.!? ]*$/i.test(normalized)) return false;
  return /[?？]|\b(sao|chua|lai|van|khong tra loi|hoi lai)\b/i.test(normalized);
}

function uniqueStrings(items = []) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeSignalText(text = '') {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function detectBookingInputSlots(normalizedText = '') {
  const dateTokens = String(normalizedText || '').match(/\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?|hom kia|hom qua|hom nay|hnay|ngay mai|mai|ngay mot|ngay kia|mot|toi nay|dem nay|toi mai|dem mai/g) || [];
  const hasRelativeStartAndExplicitEnd = /\b(hom kia|hom qua|hom nay|hnay|ngay mai|mai|ngay mot|ngay kia|mot|toi nay|dem nay|toi mai|dem mai)\b/.test(normalizedText) && /\b(out|checkout|check-out|tra phong|den|toi)\b.{0,24}\d{1,2}[\/-]\d{1,2}/.test(normalizedText);
  const hasDateRange = dateTokens.length >= 2 || hasRelativeStartAndExplicitEnd || /(tu|from).{0,20}(den|toi|to)/.test(normalizedText) || /\b\d{1,2}\s*(dem|night|nights)\b/.test(normalizedText);
  const hasOccupancy = /\d+\s*(khach|nguoi|pax|phong ngu|phong|pn|bedroom|adults?)/i.test(normalizedText);
  const asksAvailability = /(con phong|phong trong|tim phong|dat phong|bao gia|gia phong|availability|booking|check phong)/i.test(normalizedText);
  return { hasDateRange, hasOccupancy, asksAvailability };
}

function classifyInputSituation({ text = '', normalizedText = '', intent = 'general', complexity = 'simple', confidence = 0.5, hasAttachments = false, bookingSlots = {} } = {}) {
  const length = String(text || '').length;
  if (hasAttachments) return 'multimodal_or_file';
  if (Number(confidence) < 0.65 || String(complexity) === 'complex') return 'ambiguous_or_low_confidence';
  if (['availability', 'quote', 'booking', 'pricing'].includes(String(intent)) && bookingSlots.asksAvailability) {
    return bookingSlots.hasDateRange && bookingSlots.hasOccupancy ? 'booking_ready_live' : 'booking_missing_slots';
  }
  if (length > 700 || String(complexity) === 'structured') return 'long_structured_request';
  if (/(khieu nai|buc|tuc|hoan tien|gap quan ly|refund|complaint|urgent)/i.test(normalizedText)) return 'risk_or_complaint';
  return 'simple_text';
}
function resolveAgentModelAssignment({ agentId, intent = 'general', knowledgeSources = [], preferredTier = 'small', signal = {}, config = DEFAULT_AI_AUTOMATION_CONFIG } = {}) {
  const normalizedConfig = normalizeAiAutomationConfig(config);
  const catalog = Array.isArray(normalizedConfig.modelCatalog) ? normalizedConfig.modelCatalog : [];
  const desiredUseCases = modelUseCasesForAgent(agentId, intent, signal, knowledgeSources);
  const candidates = catalog
    .filter((item) => item && typeof item === 'object')
    .filter((item) => item.tier === preferredTier || (preferredTier === 'medium' && item.tier === 'small' && agentId === 'retrieval'))
    .map((item) => ({ item, score: scoreModelCandidate(item, desiredUseCases, signal) }))
    .sort((a, b) => b.score - a.score || Number(a.item.promptPricePer1M || 0) - Number(b.item.promptPricePer1M || 0));
  const picked = candidates[0]?.item || fallbackModelCandidate(catalog, preferredTier);
  return {
    tier: picked?.tier || preferredTier,
    modelId: picked?.modelId || null,
    label: picked?.label || picked?.id || null,
    reason: buildModelReason(agentId, picked, desiredUseCases, signal)
  };
}

function modelUseCasesForAgent(agentId, intent, signal, knowledgeSources) {
  if (agentId === 'orchestrator') {
    if (signal.highRisk) return ['complex_multistep', 'high_stakes_handoff'];
    if (signal.hasAttachments) return ['file_grounding', 'multimodal_guest_request'];
    if (signal.bookingReady) return ['classify_intent', 'light_routing', 'quote_reasoning'];
    return ['classify_intent', 'light_routing'];
  }
  if (agentId === 'retrieval') {
    if (signal.hasAttachments) return ['file_grounding', 'retrieval_planning'];
    return ['retrieval_planning'];
  }
  if (agentId === 'booking_agent') return signal.bookingReady ? ['classify_intent', 'light_routing', 'quote_reasoning'] : ['classify_intent', 'light_routing'];
  if (agentId === 'hotel_live_data') return ['retrieval_planning', 'quote_reasoning'];
  if (agentId === 'room_detail_agent') return ['retrieval_planning', 'quote_reasoning', 'compose_structured'];
  if (agentId === 'policy_guard') {
    if (signal.highRisk || intent === 'complaint') return ['complaint', 'final_review'];
    if (signal.hasAttachments) return ['verification_with_attachments'];
    return ['verifier_text_only', 'policy_lookup'];
  }
  if (agentId === 'composer') {
    if (signal.highRisk || intent === 'complaint') return ['final_review', 'complaint'];
    if (signal.hasAttachments) return ['compose_structured', 'multimodal_guest_request'];
    if (knowledgeSources.some((item) => item.type === 'api')) return ['compose_structured', 'quote_reasoning'];
    return ['faq_simple'];
  }
  return ['faq_simple'];
}

function scoreModelCandidate(model, desiredUseCases, signal) {
  let score = 0;
  const modelUseCases = Array.isArray(model.useCases) ? model.useCases : [];
  for (const useCase of desiredUseCases) {
    if (modelUseCases.includes(useCase)) score += 5;
  }
  const modality = String(model.modality || '').toLowerCase();
  if (signal.hasAttachments && /(image|file|audio|video)/.test(modality)) score += 4;
  if (!signal.hasAttachments && model.tier === 'small') score += 1;
  if (signal.highRisk && model.tier === 'large') score += 4;
  if (!signal.highRisk && model.tier === 'small') score += 2;
  if (signal.hasLiveToolData && modelUseCases.includes('quote_reasoning')) score += 3;
  if (signal.bookingReady && modelUseCases.includes('quote_reasoning')) score += 2;
  if (signal.inputSituation === 'booking_missing_slots' && model.tier === 'small') score += 3;
  if (signal.inputSituation === 'ambiguous_or_low_confidence' && model.tier === 'medium') score += 2;
  if (signal.inputSituation === 'risk_or_complaint' && model.tier !== 'small') score += 3;
  const promptCost = Number(model.promptPricePer1M || 0);
  const completionCost = Number(model.completionPricePer1M || 0);
  const costPenalty = promptCost * 0.25 + completionCost * 0.08;
  score -= costPenalty;
  if (!signal.highRisk && !signal.hasAttachments && promptCost <= 0.2 && completionCost <= 0.5) score += 1.5;
  return score;
}

function fallbackModelCandidate(catalog, preferredTier) {
  return catalog.find((item) => item?.tier === preferredTier)
    || catalog.find((item) => item?.tier === 'medium')
    || catalog[0]
    || null;
}

function buildModelReason(agentId, picked, desiredUseCases, signal) {
  const reasons = [agentId];
  if (desiredUseCases.length) reasons.push(`useCases:${desiredUseCases.join('|')}`);
  if (signal.hasAttachments) reasons.push('has-attachments');
  if (signal.highRisk) reasons.push('high-risk');
  if (signal.inputSituation) reasons.push(`situation:${signal.inputSituation}`);
  if (signal.bookingReady) reasons.push('booking-ready');
  if (Array.isArray(signal.missingBookingSlots) && signal.missingBookingSlots.length) reasons.push(`missing:${signal.missingBookingSlots.join('|')}`);
  if (picked?.tier) reasons.push(`tier:${picked.tier}`);
  return reasons.join(' · ');
}

function sanitizeLastDecision(value) {
  return {
    action: String(value.action || '').trim() || null,
    reason: String(value.reason || '').trim() || null,
    modelTier: String(value.modelTier || '').trim() || null,
    at: normalizeDateTime(value.at) || null
  };
}

function sanitizeConversationMemory(value = {}) {
  return {
    lastIntent: String(value.lastIntent || '').trim() || null,
    lastCustomerMessage: trimMemoryText(value.lastCustomerMessage, 500),
    lastReply: trimMemoryText(value.lastReply, 500),
    summary: trimMemoryText(value.summary, 700),
    updatedAt: normalizeDateTime(value.updatedAt) || null
  };
}

function sanitizeMessageTraces(input = {}) {
  return Object.fromEntries(Object.entries(input || {})
    .slice(-80)
    .map(([key, value]) => {
      const trace = value && typeof value === 'object' ? value : {};
      return [String(key || '').trim(), {
        id: String(trace.id || '').trim() || null,
        at: normalizeDateTime(trace.at) || null,
        accountId: String(trace.accountId || '').trim() || null,
        threadId: String(trace.threadId || '').trim() || null,
        departmentId: String(trace.departmentId || '').trim() || null,
        messageKey: String(trace.messageKey || key || '').trim() || null,
        status: String(trace.status || 'info').trim(),
        reason: String(trace.reason || '').trim() || null,
        decision: String(trace.decision || '').trim() || null,
        provider: String(trace.provider || '').trim() || null,
        modelId: String(trace.modelId || '').trim() || null,
        modelTier: String(trace.modelTier || '').trim() || null,
        textPreview: String(trace.textPreview || '').trim(),
        replyPreview: String(trace.replyPreview || '').trim(),
        error: String(trace.error || '').trim() || null,
        nodes: Array.isArray(trace.nodes) ? trace.nodes.slice(0, 20).map((node) => ({
          stage: String(node?.stage || '').trim() || null,
          label: String(node?.label || node?.stage || '').trim() || null,
          status: String(node?.status || 'info').trim(),
          detail: String(node?.detail || node?.reason || '').trim() || null
        })) : []
      }];
    })
    .filter(([key]) => key));
}

function sanitizeMemoryRows(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sanitizeMemoryRow(item))
    .filter(Boolean)
    .slice(-500);
}

function sanitizeMemoryRow(value = {}) {
  const id = String(value.id || '').trim() || null;
  const text = trimMemoryText(value.text, 1500);
  const kind = oneOf(value.kind, ['customer', 'reply', 'agent_summary'], 'customer');
  const scope = oneOf(value.scope, ['conversation', 'agent'], 'conversation');
  const agentId = String(value.agentId || '').trim() || null;
  const agentLabel = trimMemoryText(value.agentLabel, 160);
  const intent = String(value.intent || '').trim() || null;
  const createdAt = normalizeDateTime(value.createdAt) || normalizeDateTime(value.updatedAt) || null;
  if (!id || !text) return null;
  return { id, kind, scope, agentId, agentLabel, intent, text, createdAt };
}

function sanitizeAgentMemories(value = {}) {
  return Object.fromEntries(Object.entries(value || {})
    .map(([agentId, memory]) => [String(agentId || '').trim(), sanitizeAgentMemoryEntry(memory)])
    .filter(([agentId, memory]) => agentId && memory));
}

function sanitizeAgentMemoryEntry(value = {}) {
  const summary = trimMemoryText(value.summary, 700);
  const lastIntent = String(value.lastIntent || '').trim() || null;
  const lastCustomerMessage = trimMemoryText(value.lastCustomerMessage, 500);
  const lastReply = trimMemoryText(value.lastReply, 500);
  const updatedAt = normalizeDateTime(value.updatedAt) || null;
  if (!summary && !lastIntent && !lastCustomerMessage && !lastReply && !updatedAt) return null;
  return { summary, lastIntent, lastCustomerMessage, lastReply, updatedAt };
}

function trimMemoryText(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function normalizeOpenConfigArray(items) {
  return (Array.isArray(items) ? items : []).map((item, index) => {
    if (!item || typeof item !== 'object') {
      return { id: `item_${index + 1}`, value: item ?? null };
    }
    const clone = { ...item };
    if (!clone.id) clone.id = `item_${index + 1}`;
    return clone;
  });
}

function normalizeKnowledgeSources(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      id: String(item?.id || `source_${index + 1}`).trim(),
      label: String(item?.label || item?.id || `Source ${index + 1}`).trim(),
      type: oneOf(item?.type, ['api', 'rag', 'flow', 'cache'], 'rag'),
      enabled: item?.enabled !== false,
      intents: uniqStrings(item?.intents?.length ? item.intents : ['general']),
      priority: clampInt(item?.priority, 0, 9999, 50)
    }))
    .filter((item) => item.id);
}

function normalizeModelRouter(input = {}) {
  return {
    classify: oneOf(input.classify, ['small', 'medium', 'large'], 'small'),
    retrieve: oneOf(input.retrieve, ['small', 'medium', 'large'], 'small'),
    composeSimple: oneOf(input.composeSimple, ['small', 'medium', 'large'], 'small'),
    composeStructured: oneOf(input.composeStructured, ['small', 'medium', 'large'], 'medium'),
    complaint: oneOf(input.complaint, ['small', 'medium', 'large'], 'large'),
    fallback: oneOf(input.fallback, ['small', 'medium', 'large'], 'small')
  };
}

function normalizeSnoozePresets(items) {
  const source = Array.isArray(items) && items.length ? items : DEFAULT_SNOOZE_PRESETS_MINUTES;
  return [...new Set(source.map((item) => clampInt(item, 1, 24 * 60, null)).filter(Boolean))].sort((a, b) => a - b);
}

function normalizeDateTime(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (!base || typeof base !== 'object' || !extra || typeof extra !== 'object') return extra ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

function uniqStrings(items) {
  return [...new Set((Array.isArray(items) ? items : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function clampInt(value, min, max, fallback) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export async function runIsolatedAgent({ sessionId, agentId, input, executionId = null, depth = 0, maxDepth = 4, trace = null } = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedAgentId = String(agentId || 'orchestrator').trim();
  const agent = getAgentById(normalizedAgentId);
  if (!agent) throw new Error(`Không tìm thấy agent: ${normalizedAgentId}`);
  if (!normalizedSessionId) throw new Error('Thiếu session_id');
  if (depth > maxDepth) throw new Error('Vượt quá giới hạn gọi sub-agent');

  const startedAt = Date.now();
  const tools = listToolsForAgent(normalizedAgentId);
  const history = loadAgentMemory(normalizedSessionId, normalizedAgentId).map((item) => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: item.content || ' '
  }));
  const toolGuide = tools.length
    ? `\n\nTools được phép dùng:\n${tools.map((tool) => `- ${tool.id} (${tool.type}): ${tool.description}${tool.target_agent_id ? ` -> target_agent_id=${tool.target_agent_id}` : ''}`).join('\n')}\nNếu cần dùng tool/sub_agent, trả JSON dạng {"tool_calls":[{"tool_id":"...","input":"..."}],"final":"..."}. Nếu không cần tool, trả lời bình thường.`
    : '';
  const systemPrompt = `${agent.system_instruction || ' '}${toolGuide}`;
  const userInput = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  const modelId = routeModel(userInput);
  saveAgentMemory(normalizedSessionId, normalizedAgentId, 'user', userInput);

  trace?.({
    nodeType: 'router',
    nodeName: `Model router for ${normalizedAgentId}`,
    inputData: { text: userInput, agentId: normalizedAgentId },
    outputData: { modelId },
    modelUsed: modelId,
    durationMs: 0
  });

  const result = await callOpenRouter(modelId, systemPrompt, history, userInput);
  const firstText = result.text || ' ';
  saveAgentMemory(normalizedSessionId, normalizedAgentId, 'assistant', firstText);
  trace?.({
    nodeType: 'agent',
    nodeName: normalizedAgentId,
    inputData: { sessionId: normalizedSessionId, input: userInput, tools: tools.map((tool) => tool.id) },
    outputData: { text: firstText },
    modelUsed: result.modelId || modelId,
    durationMs: Date.now() - startedAt
  });

  const toolCalls = extractAgentToolCalls(firstText);
  if (!toolCalls.length) {
    return { agentId: normalizedAgentId, output: firstText, modelId: result.modelId || modelId, toolResults: [] };
  }

  const toolResults = [];
  for (const call of toolCalls) {
    const tool = getToolForAgent(normalizedAgentId, call.tool_id || call.toolId || call.name);
    if (!tool) {
      toolResults.push({ ok: false, toolId: call.tool_id || call.toolId || call.name, error: 'tool_not_allowed' });
      continue;
    }
    const toolStartedAt = Date.now();
    let output;
    if (tool.type === 'sub_agent') {
      const childAgentId = String(tool.target_agent_id || '').trim();
      output = await runIsolatedAgent({
        sessionId: normalizedSessionId,
        agentId: childAgentId,
        input: call.input ?? firstText,
        executionId,
        depth: depth + 1,
        maxDepth,
        trace
      });
    } else {
      output = await runFunctionTool(tool, call.input ?? firstText);
    }
    const toolResult = { ok: true, toolId: tool.id, type: tool.type, targetAgentId: tool.target_agent_id || null, output };
    toolResults.push(toolResult);
    trace?.({
      nodeType: tool.type === 'sub_agent' ? 'sub_agent' : 'tool',
      nodeName: tool.id,
      inputData: { parentAgentId: normalizedAgentId, input: call.input ?? null },
      outputData: toolResult,
      modelUsed: output?.modelId || null,
      durationMs: Date.now() - toolStartedAt
    });
  }

  const finalInput = `Kết quả các tool/sub-agent:\n${JSON.stringify(toolResults, null, 2)}\n\nHãy tổng hợp thành phản hồi cuối, chỉ dựa trên dữ liệu trên.`;
  const finalResult = await callOpenRouter(modelId, systemPrompt, [...history, { role: 'assistant', content: firstText }], finalInput);
  const finalOutput = finalResult.text || firstText || ' ';
  saveAgentMemory(normalizedSessionId, normalizedAgentId, 'assistant', finalOutput);
  trace?.({
    nodeType: 'agent',
    nodeName: `${normalizedAgentId}:final`,
    inputData: { toolResults },
    outputData: { text: finalOutput },
    modelUsed: finalResult.modelId || modelId,
    durationMs: Date.now() - startedAt
  });
  return { agentId: normalizedAgentId, output: finalOutput, modelId: finalResult.modelId || modelId, toolResults };
}

export function extractAgentToolCalls(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const parsed = tryParseJsonBlock(raw);
  const calls = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : (Array.isArray(parsed?.tools) ? parsed.tools : []);
  return calls
    .map((item) => ({
      tool_id: String(item?.tool_id || item?.toolId || item?.name || '').trim(),
      input: item?.input ?? item?.arguments ?? item?.payload ?? ''
    }))
    .filter((item) => item.tool_id);
}

async function runFunctionTool(tool = {}, input = '') {
  return {
    ok: true,
    toolId: tool.id,
    message: 'Function tool được runtime hiện tại xử lý qua pipeline sẵn có; agent_system ghi trace và trả input để orchestrator tổng hợp.',
    input
  };
}

function tryParseJsonBlock(text = '') {
  const raw = String(text || '').trim();
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) candidates.push(objectMatch[0]);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }
  return null;
}
